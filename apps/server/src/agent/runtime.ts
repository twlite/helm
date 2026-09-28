import type {
  ActionReceipt,
  AgentDecision,
  AgentStep,
  AgentTurnContext,
  CompletionCriterion,
  EnvironmentObservation,
  Memory,
  Message,
  OrchestratorDecision,
  Run,
  RunDiagnostics,
  RunStep,
  TaskDefinition,
  ToolError,
  ToolResult,
  TaskRequirement,
  VerificationResult,
} from '@helm/shared';
import { browserUrlsMatch, deriveBrowserReadQuery } from '@helm/shared';

import { CriterionVerifierRegistry } from '../tools/criterion-verifier';
import type { GuestTransport } from '../tools/guest-transport';
import { ToolRegistry } from '../tools/tool-registry';
import {
  browserResearchSearchUrl,
  browserResearchStartUrl,
  explicitBrowserNavigationUrls,
  isAbsoluteBrowserNavigationUrl,
  isSearchEngineUrl,
  isSearchResultsUrl,
  isUnsupportedSearchEngineUrl,
} from './browser-research';
import { fingerprintAction, LoopDetector } from './fingerprint';
import { DEFAULT_RUNTIME_BUDGETS, RunBudget, RunCancellation } from './limits';
import { GuestObservationProvider } from './observation';
import { allowedWorkerTool, fallbackObjective, FallbackOrchestrator, objectiveForRequirement, recoverOrchestratorBlocker } from './orchestrator';
import {
  addFailedStrategy,
  artifactsFromResult,
  blocker,
  compactEnvironmentObservation,
  createTaskState,
  evidenceFromObservation,
  findObservedSearchRefForUrl,
  hasUnopenedSearchResults,
  isTaskOutputPathNavigation,
  latestSuccessfulWebSearch,
  mergeWorkerResult,
  observedFactsFromToolResult,
  progressFingerprint,
  unopenedSearchResults,
  updateCompletedRequirements,
  updateProgress,
  taskRequirementSummary,
  requirementsForTask,
  requiredActionForRequirement,
  selectedBrowserArtifact,
  verificationActions,
  verifyTaskState,
} from './task-state';
import type {
  ActingAgentProvider,
  AgentRuntimeOptions,
  AgentRuntimeResult,
  DecisionProvider,
  MemoryRecallInput,
  ObservationProvider,
  RunTaskInput,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeRepository,
  OrchestratorProvider,
  TaskPlanner,
  TaskCompiler,
  VerificationProvider,
  WorkerProvider,
  WorkerResult,
} from './types';

function defaultIdFactory(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isTaskDefinition(value: unknown): value is TaskDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'threadId' in value &&
    'goal' in value &&
    'criteria' in value &&
    Array.isArray((value as { criteria?: unknown }).criteria)
  );
}

function criterionKey(criterion: CompletionCriterion): string {
  return JSON.stringify(criterion);
}

/**
 * Legacy requirements-first helpers, used only when no acting agent is configured.
 * Production acting-agent runs bypass navigation policy and workflow guards.
 */
type NavigationProvenance = 'user' | 'search-result' | 'page-link' | 'verified-memory' | 'duckduckgo-search' | 'navigation-result';

interface UrlCapability {
  provenance: NavigationProvenance;
  semanticRef?: { ref: string; linkIndex?: number };
}

interface BrowserNavigationPolicy {
  request: string;
  allowedUrls: Map<string, UrlCapability>;
  attempted: boolean;
  forceDuckDuckGo: boolean;
}

interface PreparedNavigation {
  input: Record<string, unknown>;
  provenance?: NavigationProvenance;
  requestedUrl?: string;
  error?: ToolResult;
}

function navigationKey(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function createBrowserNavigationPolicy(input: {
  userMessage: string;
  conversation?: readonly Message[];
}, memories: readonly Memory[]): BrowserNavigationPolicy {
  const allowedUrls = new Map<string, UrlCapability>();
  for (const message of input.conversation ?? []) {
    if (message.role !== 'user') continue;
    for (const url of explicitBrowserNavigationUrls(message.content)) {
      const key = navigationKey(url);
      if (key) allowedUrls.set(key, { provenance: 'user' });
    }
  }
  for (const url of explicitBrowserNavigationUrls(input.userMessage)) {
    const key = navigationKey(url);
    if (key) allowedUrls.set(key, { provenance: 'user' });
  }
  for (const memory of memories) {
    const hasVerifiedProvenance = Boolean(
      memory.lastVerifiedAt || (memory.source === 'observed' && (memory.evidenceIds?.length ?? 0) > 0),
    );
    const verifiedMemoryUrls = hasVerifiedProvenance
      ? [...(memory.sourceUrl ? [memory.sourceUrl] : []), ...explicitBrowserNavigationUrls(memory.content)]
      : [];
    for (const url of verifiedMemoryUrls) {
      if (!url) continue;
      const key = navigationKey(url);
      if (key && !allowedUrls.has(key)) allowedUrls.set(key, { provenance: 'verified-memory' });
    }
  }
  return { request: input.userMessage, allowedUrls, attempted: false, forceDuckDuckGo: false };
}

function prepareBrowserNavigation(
  tool: string,
  toolInput: Record<string, unknown>,
  policy: BrowserNavigationPolicy,
): PreparedNavigation {
  if (policy.forceDuckDuckGo && tool.startsWith('browser.') && tool !== 'browser.navigate') {
    return {
      input: toolInput,
      error: {
        ok: false,
        error: {
          code: 'VERIFIED_URL_RECOVERY_REQUIRED',
          message: 'The exact URL saved in memory failed or redirected. Search DuckDuckGo for the current task before reading or inspecting this destination.',
        },
      },
    };
  }
  if (tool === 'browser.download' && typeof toolInput.url === 'string') {
    const key = navigationKey(toolInput.url);
    const capability = key ? policy.allowedUrls.get(key) : undefined;
    if (!capability) {
      return {
        input: toolInput,
        error: {
          ok: false,
          error: {
            code: 'UNOBSERVED_DOWNLOAD_URL',
            message: 'Download URLs must come from the user, verified memory, or an observed page link. Open a DuckDuckGo result or inspect the page link first.',
          },
        },
      };
    }
    return { input: toolInput, provenance: capability.provenance, requestedUrl: toolInput.url };
  }
  if (tool !== 'browser.navigate' || typeof toolInput.url !== 'string') return { input: toolInput };
  const requestedUrl = toolInput.url.trim();
  let parsed: URL | undefined;
  try { parsed = new URL(requestedUrl); } catch {
    const explicit = policy.allowedUrls.get(navigationKey(`https://${requestedUrl}`) ?? '');
    if (explicit) {
      policy.attempted = true;
      return { input: { ...toolInput, url: `https://${requestedUrl}` }, provenance: explicit.provenance, requestedUrl };
    }
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return { input: toolInput };

  if (isUnsupportedSearchEngineUrl(parsed.href)) {
    const normalizedSearchUrl = browserResearchStartUrl(parsed.href);
    policy.attempted = true;
    policy.forceDuckDuckGo = false;
    return { input: { ...toolInput, url: normalizedSearchUrl }, provenance: 'duckduckgo-search', requestedUrl };
  }
  if (isSearchEngineUrl(parsed.href)) {
    policy.attempted = true;
    policy.forceDuckDuckGo = false;
    return { input: toolInput, provenance: 'duckduckgo-search', requestedUrl };
  }
  if (policy.forceDuckDuckGo) {
    policy.attempted = true;
    policy.forceDuckDuckGo = false;
    const query = deriveBrowserReadQuery(policy.request) || policy.request;
    return { input: { ...toolInput, url: browserResearchSearchUrl(query) }, provenance: 'duckduckgo-search', requestedUrl };
  }
  const capability = policy.allowedUrls.get(parsed.href);
  if (capability?.semanticRef) {
    return {
      input: toolInput,
      requestedUrl,
      error: {
        ok: false,
        error: {
          code: 'OBSERVED_DESTINATION_REQUIRES_REF',
          message: `This destination was observed in a browser result. Use browser.open({ ref: "${capability.semanticRef.ref}"${capability.semanticRef.linkIndex === undefined ? '' : `, linkIndex: ${capability.semanticRef.linkIndex}`} }) so the guest resolves the exact observed href.`,
          details: capability.semanticRef,
        },
      },
    };
  }
  if (capability) {
    policy.attempted = true;
    return { input: toolInput, provenance: capability.provenance, requestedUrl };
  }
  if (!policy.attempted) {
    policy.attempted = true;
    const query = deriveBrowserReadQuery(policy.request) || policy.request;
    return {
      input: { ...toolInput, url: browserResearchSearchUrl(query) },
      provenance: 'duckduckgo-search',
      requestedUrl,
    };
  }
  return {
    input: toolInput,
    requestedUrl,
    error: {
      ok: false,
      error: {
        code: 'UNOBSERVED_NAVIGATION_URL',
        message: 'This URL was not supplied by the user or observed in page links, DuckDuckGo results, or exact memory. Search DuckDuckGo first and navigate using an observed result href.',
      },
    },
  };
}

function rememberObservedBrowserUrls(
  tool: string,
  data: unknown,
  policy: BrowserNavigationPolicy,
): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  if (tool === 'browser.webSearch' && record.searchCompleted === true) policy.attempted = true;
  const add = (
    value: unknown,
    provenance: NavigationProvenance,
    semanticRef?: UrlCapability['semanticRef'],
  ): void => {
    if (typeof value !== 'string') return;
    const key = navigationKey(value);
    if (!key) return;
    const current = policy.allowedUrls.get(key);
    if (!current || (current.provenance === 'page-link' && provenance === 'search-result')) {
      policy.allowedUrls.set(key, { provenance, ...(semanticRef ? { semanticRef } : {}) });
    }
  };
  if (tool === 'browser.navigate') add(record.url, 'navigation-result');
  if (tool === 'browser.snapshot' && Array.isArray(record.elements)) {
    for (const item of record.elements) {
      if (typeof item === 'object' && item !== null) add((item as Record<string, unknown>).href, 'page-link');
    }
  }
  if (tool === 'browser.inspectRegion' && Array.isArray(record.links)) {
    for (const item of record.links) {
      if (typeof item === 'object' && item !== null) add((item as Record<string, unknown>).href, 'page-link');
    }
  }
  if (tool === 'browser.read' && Array.isArray(record.blocks)) {
    for (const item of record.blocks) {
      if (typeof item !== 'object' || item === null) continue;
      const block = item as Record<string, unknown>;
      const provenance: NavigationProvenance = block.type === 'search_result' ? 'search-result' : 'page-link';
      add(block.href, provenance, typeof block.ref === 'string' ? { ref: block.ref } : undefined);
      if (Array.isArray(block.links)) {
        for (const [linkIndex, link] of block.links.entries()) {
          if (typeof link === 'object' && link !== null) {
            add((link as Record<string, unknown>).href, 'page-link', typeof block.ref === 'string' ? { ref: block.ref, linkIndex } : undefined);
          }
        }
      }
    }
  }
  if ((tool === 'browser.webSearch' || tool === 'browser.findPage') && Array.isArray(record.results)) {
    for (const item of record.results) {
      if (typeof item !== 'object' || item === null) continue;
      const block = item as Record<string, unknown>;
      const provenance: NavigationProvenance = tool === 'browser.webSearch' || block.type === 'search_result'
        ? 'search-result'
        : 'page-link';
      add(block.href, provenance, typeof block.ref === 'string' ? { ref: block.ref } : undefined);
      if (Array.isArray(block.links)) {
        for (const [linkIndex, link] of block.links.entries()) {
          if (typeof link === 'object' && link !== null) {
            add((link as Record<string, unknown>).href, 'page-link', typeof block.ref === 'string' ? { ref: block.ref, linkIndex } : undefined);
          }
        }
      }
    }
  }
  if (tool === 'browser.open') {
    add(record.openedHref, record.sourceType === 'search_result' ? 'search-result' : 'page-link');
    add(record.url, 'navigation-result');
  }
}

function recordBrowserOpenOutcome(result: ToolResult): ToolResult {
  if (!result.ok || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) return result;
  const data = result.data as Record<string, unknown>;
  const provenance: NavigationProvenance = data.sourceType === 'search_result' ? 'search-result' : 'page-link';
  const evidence = typeof result.evidence === 'object' && result.evidence !== null && !Array.isArray(result.evidence)
    ? result.evidence as Record<string, unknown>
    : undefined;
  const receipt = typeof evidence?.receipt === 'object' && evidence.receipt !== null && !Array.isArray(evidence.receipt)
    ? evidence.receipt as Record<string, unknown>
    : undefined;
  const effect = typeof receipt?.effect === 'object' && receipt.effect !== null && !Array.isArray(receipt.effect)
    ? receipt.effect as Record<string, unknown>
    : undefined;
  return {
    ...result,
    data: { ...data, urlProvenance: provenance },
    ...(evidence && receipt ? {
      evidence: {
        ...evidence,
        receipt: {
          ...receipt,
          effect: {
            ...effect,
            ...(typeof data.openedHref === 'string' ? { requestedUrl: data.openedHref } : {}),
            urlProvenance: provenance,
          },
        },
      },
    } : {}),
  };
}

function attachNavigationProvenance(result: ToolResult, navigation: PreparedNavigation): ToolResult {
  if (!result.ok || !navigation.provenance || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) return result;
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      urlProvenance: navigation.provenance,
      ...(navigation.requestedUrl && navigation.requestedUrl !== navigation.input.url ? { proposedUrl: navigation.requestedUrl } : {}),
    },
  };
}

function recordNavigationOutcome(
  result: ToolResult,
  navigation: PreparedNavigation,
  policy: BrowserNavigationPolicy,
): ToolResult {
  if (navigation.provenance === 'verified-memory') {
    const requested = typeof navigation.input.url === 'string' ? navigation.input.url : undefined;
    if (!result.ok) {
      if (requested) policy.allowedUrls.delete(navigationKey(requested) ?? '');
      policy.forceDuckDuckGo = true;
      return result;
    }
    const data = typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
      ? result.data as Record<string, unknown>
      : undefined;
    const reached = typeof data?.url === 'string' ? data.url : requested;
    if (requested && reached && navigationKey(requested) !== navigationKey(reached)) {
      policy.allowedUrls.delete(navigationKey(requested) ?? '');
      policy.forceDuckDuckGo = true;
      return attachNavigationProvenance({
        ...result,
        data: { ...data, expectedUrl: requested, unexpectedRedirect: reached },
      }, navigation);
    }
  }
  return attachNavigationProvenance(result, navigation);
}

function withDerivedBrowserReadQuery(
  tool: string,
  input: Record<string, unknown>,
  task: TaskDefinition,
  request: string,
): Record<string, unknown> {
  if (tool !== 'browser.read' || input.ref !== undefined || typeof input.query === 'string') return input;
  // The original user wording is the best source for extraction terms. A
  // planner's normalized task title or criterion text may contain only output
  // details and lose the subject the browser needs to retrieve.
  const query = deriveBrowserReadQuery(request || task.originalRequest || task.goal);
  return query ? { ...input, query } : input;
}

function invalidBrowserNavigationResult(
  tool: string,
  input: Record<string, unknown>,
  enabled: boolean,
  task?: TaskDefinition,
): ToolResult | undefined {
  if (!enabled || tool !== 'browser.navigate') return undefined;
  const url = typeof input.url === 'string' ? input.url : undefined;
  if (url !== undefined && task && isTaskOutputPathNavigation(task, url)) {
    return {
      ok: false,
      error: {
        code: 'OUTPUT_PATH_NOT_NAVIGATION',
        message: 'The requested output path belongs to the filesystem or desktop worker and must not be opened in the browser.',
      },
    };
  }
  if (url !== undefined && isAbsoluteBrowserNavigationUrl(url)) return undefined;
  return {
    ok: false,
    error: {
      code: 'INVALID_BROWSER_NAVIGATION',
      message: 'Browser navigation requires an absolute http(s), file, or about URL. Output filenames must be handled by filesystem or desktop tools.',
    },
  };
}

function error(code: string, message: string, details?: unknown): ToolError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function browserNavigationGuard(tool: string, input: Record<string, unknown>): ToolResult | undefined {
  if (tool !== 'browser.navigate') return undefined;
  const value = input.url;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: { code: 'INVALID_BROWSER_URL', message: 'browser.navigate requires a non-empty absolute URL.' } };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: { code: 'INVALID_BROWSER_URL', message: 'browser.navigate requires an absolute URL, not a filesystem path or bare hostname.' } };
  }
  if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) {
    return { ok: false, error: { code: 'INVALID_BROWSER_PROTOCOL', message: `Browser navigation does not allow the ${parsed.protocol} protocol.` } };
  }
  return undefined;
}

function successfulReceiptEffect(result: ToolResult): Record<string, unknown> | undefined {
  if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence)) return undefined;
  const receipt = (result.evidence as Record<string, unknown>).receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
  const effect = (receipt as Record<string, unknown>).effect;
  return effect && typeof effect === 'object' && !Array.isArray(effect) ? effect as Record<string, unknown> : undefined;
}

function hasReadableBrowserContent(result: ToolResult): boolean {
  if (!result.ok || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) return false;
  const data = result.data as Record<string, unknown>;
  if (data.operation !== 'read') return false;
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const hasSectionText = sections.some(section => (
    typeof section === 'object' && section !== null
    && typeof (section as Record<string, unknown>).text === 'string'
    && ((section as Record<string, unknown>).text as string).trim().length > 0
  ));
  return hasSectionText || (Array.isArray(data.blocks) && data.blocks.length > 0);
}

function actionEffectChanged(result: ToolResult): boolean {
  const effect = successfulReceiptEffect(result);
  if (!effect) return false;
  return Boolean(
    effect.navigationOccurred
    || effect.newTabOpened
    || effect.domChanged
    || effect.downloadStarted
    || (typeof effect.existsBefore === 'boolean' && typeof effect.existsAfter === 'boolean' && effect.existsBefore !== effect.existsAfter)
    || (effect.changed === true && effect.existsBefore === undefined && effect.existsAfter === undefined),
  );
}

function embeddedReceipt(result: ToolResult): ActionReceipt | undefined {
  if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence)) return undefined;
  const receipt = (result.evidence as Record<string, unknown>).receipt;
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? receipt as ActionReceipt
    : undefined;
}

function withRuntimeReceipt(
  tool: string,
  input: Record<string, unknown>,
  result: ToolResult,
  startedAt: string,
  now: () => number,
): ToolResult {
  if (embeddedReceipt(result)) return result;
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : undefined;
  const path = typeof data?.path === 'string' ? data.path : typeof input.path === 'string' ? input.path : undefined;
  const receipt: ActionReceipt = {
    id: `receipt-${crypto.randomUUID()}`,
    tool,
    ok: result.ok,
    effect: {
      ...(path ? { path } : {}),
      ...(typeof data?.application === 'string'
        ? { application: data.application }
        : typeof input.application === 'string' ? { application: input.application } : {}),
      ...(typeof input.url === 'string' ? { requestedUrl: input.url } : {}),
      ...(typeof data?.url === 'string' ? { urlAfter: data.url } : {}),
      ...(typeof data?.size === 'number' ? { bytesWritten: data.size } : {}),
      ...(typeof data?.sha256 === 'string' ? { sha256: data.sha256 } : {}),
      ...(tool === 'fs.write' && result.ok && typeof data?.sha256 === 'string' ? { writePerformed: true } : {}),
      ...(tool === 'memory.remember' && result.ok ? { changed: data?.action !== 'already-present' } : {}),
      ...(tool === 'memory.update' && result.ok ? { changed: data?.action === 'updated' } : {}),
      ...(tool === 'memory.forget' && result.ok ? { changed: data?.deleted === true } : {}),
    },
    startedAt,
    completedAt: new Date(now()).toISOString(),
    ...(result.error ? { error: result.error } : {}),
  };
  const priorEvidence = result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence)
    ? result.evidence as Record<string, unknown>
    : result.evidence === undefined ? {} : { originalEvidence: result.evidence };
  return { ...result, evidence: { ...priorEvidence, receipt } };
}

function normalizedTaskPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
    .replace(/^\/home\/helm\//u, '~/')
    .replace(/^\/home\/helm\/workspace\//u, '')
    .replace(/^~\/(?:workspace\/)?/u, '')
    .replace(/\/$/u, '');
}

function requirementMatchesToolCall(
  requirement: TaskRequirement,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (requiredActionForRequirement(requirement) !== tool) return false;
  const target = requirement.target;
  if (target?.path && (typeof input.path !== 'string' || normalizedTaskPath(input.path) !== normalizedTaskPath(target.path))) return false;
  const actualApplication = tool === 'app.openFile' && input.application === undefined
    ? 'text-editor'
    : input.application;
  if (target?.application && actualApplication !== target.application) return false;
  if (target?.url && (typeof input.url !== 'string' || !browserUrlsMatch(input.url, target.url))) return false;
  return true;
}

function unsatisfiedActionPrerequisite(
  state: ReturnType<typeof createTaskState>,
  tool: string,
  input: Record<string, unknown>,
): ToolResult | undefined {
  const requirement = requirementsForTask(state.task).find(candidate => (
    candidate.target?.freshness === 'current-run'
    && requirementMatchesToolCall(candidate, tool, input)
    && (candidate.dependsOn ?? []).some(id => !state.completedRequirementIds.includes(id))
  ));
  if (!requirement) return undefined;
  const prerequisiteId = (requirement.dependsOn ?? []).find(id => !state.completedRequirementIds.includes(id));
  const prerequisite = requirementsForTask(state.task).find(candidate => candidate.id === prerequisiteId);
  if (!prerequisiteId) return undefined;
  return {
    ok: false,
    error: {
      code: 'TASK_PREREQUISITE_NOT_SATISFIED',
      message: `Cannot perform ${tool} for ${requirement.id} until prerequisite ${prerequisiteId} is satisfied.`,
      details: {
        requirement: requirement.id,
        prerequisite: prerequisiteId,
        ...(prerequisite && requiredActionForRequirement(prerequisite)
          ? { requiredAction: requiredActionForRequirement(prerequisite) }
          : {}),
        ...(prerequisite?.target?.path ? { path: prerequisite.target.path } : requirement.target?.path ? { path: requirement.target.path } : {}),
      },
    },
  };
}

function requiredDuckDuckGoSearchFailure(
  state: ReturnType<typeof createTaskState>,
  tool: string,
): ToolResult | undefined {
  if (!tool.startsWith('browser.') || tool === 'browser.webSearch') return undefined;
  const requirement = requirementsForTask(state.task).find(candidate => (
    candidate.mandatory
    && candidate.target?.freshness === 'current-run'
    && candidate.target.action === 'browser.webSearch'
    && !state.completedRequirementIds.includes(candidate.id)
  ));
  if (!requirement) return undefined;
  return {
    ok: false,
    error: {
      code: 'TASK_PREREQUISITE_NOT_SATISFIED',
      message: `Cannot use ${tool} until the explicitly requested DuckDuckGo web search is complete.`,
      details: { requirement: requirement.id, requiredAction: 'browser.webSearch' },
    },
  };
}

function artifactWriteFailure(
  state: ReturnType<typeof createTaskState>,
  tool: string,
  input: Record<string, unknown>,
): ToolResult | undefined {
  if (tool !== 'fs.write') return undefined;
  const requirement = requirementsForTask(state.task).find(candidate => (
    candidate.id === 'outputFile'
    && candidate.mandatory
    && candidate.target?.mode === 'written-from-artifact'
    && candidate.target.action === 'fs.write'
    && !state.completedRequirementIds.includes(candidate.id)
    && typeof candidate.target.path === 'string'
    && typeof input.path === 'string'
    && normalizedTaskPath(candidate.target.path) === normalizedTaskPath(input.path)
  ));
  if (!requirement) return undefined;
  const selected = selectedBrowserArtifact(state);
  if (input.content !== undefined || typeof input.sourceRef !== 'string'
    || !selected || input.sourceRef !== selected.ref) {
    return {
      ok: false,
      error: {
        code: 'SOURCE_REF_REQUIRED',
        message: `Write ${requirement.target!.path} from the selected browser content ref using sourceRef; model-copied content cannot satisfy this artifact requirement.`,
        details: { requirement: requirement.id },
      },
    };
  }
  return undefined;
}

function actionableToolsForState(
  state: ReturnType<typeof createTaskState>,
  availableTools: readonly string[],
  exhaustedRequirements: ReadonlySet<string> = new Set(),
): string[] {
  const requirements = requirementsForTask(state.task);
  const completed = new Set(state.completedRequirementIds);
  const pendingDuckDuckGo = requirements.find(requirement => requirement.mandatory
    && requirement.target?.action === 'browser.webSearch'
    && requirement.target.freshness === 'current-run'
    && !completed.has(requirement.id)
    && (requirement.dependsOn ?? []).every(id => completed.has(id)));
  const actionable = requirements.filter(requirement => requirement.mandatory
    && !completed.has(requirement.id)
    && !exhaustedRequirements.has(requirement.id)
    && (requirement.dependsOn ?? []).every(id => completed.has(id)));
  if (pendingDuckDuckGo) {
    // Discovery is a process constraint, but other independent requirements
    // must remain executable if the search strategy fails.
    const independent = actionable.filter(requirement => requirement.id !== pendingDuckDuckGo.id);
    const names = independent.flatMap(requirement => {
      const action = requiredActionForRequirement(requirement);
      return action && !action.startsWith('browser.') && availableTools.includes(action) ? [action] : [];
    });
    return [...new Set([...names, ...(!exhaustedRequirements.has(pendingDuckDuckGo.id)
      && availableTools.includes('browser.webSearch') ? ['browser.webSearch'] : [])])].sort();
  }
  if (hasUnopenedSearchResults(state)) {
    // Search completed but no observed result has been opened yet. The browser
    // is intentionally still on DuckDuckGo; the only productive browser step
    // is opening one of the observed result refs. Do not offer another search
    // or page-local research on the search page itself.
    const independent = actionable.filter(requirement => {
      if (requirement.id === 'browserResearch' || requirement.target?.factId === 'pageContent') return false;
      if (requirement.type === 'browser') return false;
      const action = requiredActionForRequirement(requirement);
      if (action && action.startsWith('browser.')) return false;
      return true;
    });
    const names = independent.flatMap(requirement => {
      const action = requiredActionForRequirement(requirement);
      return action && !action.startsWith('browser.') && availableTools.includes(action) ? [action] : [];
    });
    if (availableTools.includes('browser.open')) names.push('browser.open');
    return [...new Set(names)].sort();
  }
  const explicitSearchCompleted = requirements.some(requirement => requirement.target?.action === 'browser.webSearch'
    && requirement.target.freshness === 'current-run'
    && completed.has(requirement.id));
  const names = new Set<string>();
  const all = new Set(availableTools);
  const addMatching = (predicate: (name: string) => boolean): void => {
    for (const name of all) if (predicate(name)) names.add(name);
  };
  for (const requirement of actionable) {
    const exactAction = requiredActionForRequirement(requirement);
    if (requirement.target?.action === 'browser.webSearch') {
      if (all.has('browser.webSearch')) names.add('browser.webSearch');
      continue;
    }
    if (requirement.id === 'browserResearch' || requirement.target?.factId === 'pageContent') {
      addMatching(name => name.startsWith('browser.') && !(explicitSearchCompleted && name === 'browser.webSearch'));
      continue;
    }
    if (exactAction) {
      if (all.has(exactAction)) names.add(exactAction);
      continue;
    }
    switch (requirement.type) {
      case 'browser':
      case 'fact':
        addMatching(name => name.startsWith('browser.'));
        break;
      case 'filesystem':
        addMatching(name => name.startsWith('fs.'));
        break;
      case 'artifact':
        addMatching(name => name.startsWith('browser.') || name.startsWith('fs.'));
        break;
      case 'desktop':
        addMatching(name => name.startsWith('app.') || name.startsWith('desktop.'));
        break;
      case 'semantic':
        addMatching(() => true);
        break;
    }
  }
  return [...names].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactAgentValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 20_000 ? value : `${value.slice(0, 19_900).trimEnd()}\n...[truncated by Helm]`;
  if (depth >= 5) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 64).map(item => compactAgentValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .map(([key, item]) => [key, compactAgentValue(item, depth + 1)]));
  }
  return String(value);
}

function compactAgentToolResult(result: ToolResult): ToolResult {
  const evidence = result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence)
    ? result.evidence as Record<string, unknown>
    : undefined;
  const receipt = evidence?.receipt;
  return {
    ok: result.ok,
    ...(result.data === undefined ? {} : { data: compactAgentValue(result.data) }),
    ...(result.error === undefined ? {} : {
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.details === undefined ? {} : { details: compactAgentValue(result.error.details) }),
      },
    }),
    ...(receipt === undefined ? {} : { evidence: { receipt: compactAgentValue(receipt) } }),
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function completionRejection(verification: VerificationResult): ToolResult {
  return {
    ok: false,
    error: {
      code: 'COMPLETION_REJECTED',
      message: `Completion rejected: ${verification.summary}`,
      details: verification.criteria.map(check => ({
        criterion: criterionKey(check.criterion),
        passed: check.passed,
        message: check.message,
      })),
    },
  };
}

function isVerificationProvider(value: CriterionVerifierRegistry | VerificationProvider): value is VerificationProvider {
  return typeof value.verifyTask === 'function';
}

export class AgentRuntime {
  private readonly guest: GuestTransport;
  private readonly tools: ToolRegistry;
  private readonly verifier: CriterionVerifierRegistry | VerificationProvider;
  private readonly decisionProvider?: DecisionProvider;
  private readonly actingAgent?: ActingAgentProvider;
  private readonly taskPlanner?: TaskPlanner;
  private readonly taskCompiler?: TaskCompiler;
  private readonly orchestrator?: OrchestratorProvider;
  private readonly worker?: WorkerProvider;
  private readonly repository?: RuntimeRepository;
  private readonly eventSink?: RuntimeEventSink;
  private readonly observationProvider: ObservationProvider;
  private readonly memories?: AgentRuntimeOptions['memories'];
  private readonly budgetOptions: AgentRuntimeOptions['budgets'];
  private readonly now: () => number;
  private readonly idFactory: (prefix: string) => string;
  private activeCancellation?: RunCancellation;
  private activeRunId?: string;

  constructor(options: AgentRuntimeOptions) {
    this.guest = options.guestTransport;
    this.tools = options.toolRegistry;
    this.verifier = options.verifier;
    this.decisionProvider = options.decisionProvider;
    this.actingAgent = options.actingAgent;
    this.taskPlanner = options.taskPlanner;
    this.taskCompiler = options.taskCompiler;
    this.orchestrator = options.orchestrator;
    this.worker = options.worker;
    this.repository = options.repository ?? options.persistence;
    this.eventSink = options.events ?? options.eventSink;
    this.observationProvider = options.observe ?? new GuestObservationProvider({ guest: this.guest });
    this.memories = options.memories;
    this.budgetOptions = options.budgets;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  get running(): boolean {
    return this.activeCancellation !== undefined;
  }

  get currentRunId(): string | undefined {
    return this.activeRunId;
  }

  cancel(reason = 'Run cancelled'): boolean {
    if (!this.activeCancellation) return false;
    this.activeCancellation.cancel(reason);
    return true;
  }

  cancelRun(reason = 'Run cancelled'): boolean {
    return this.cancel(reason);
  }

  async run(task: TaskDefinition): Promise<AgentRuntimeResult>;
  async run(input: RunTaskInput): Promise<AgentRuntimeResult>;
  async run(taskOrInput: TaskDefinition | RunTaskInput): Promise<AgentRuntimeResult> {
    if (this.activeCancellation) throw new Error('AgentRuntime already has an active run');

    const input = isTaskDefinition(taskOrInput)
      ? { threadId: taskOrInput.threadId, userMessage: taskOrInput.goal, task: taskOrInput }
      : taskOrInput;
    const memories = await this.loadMemories({
      threadId: input.threadId,
      userMessage: input.userMessage,
      conversation: input.conversation,
      signal: input.signal,
    });
    // Keep a mutable per-run conversation window. The server can inject
    // steering messages between tool turns without changing the persisted
    // thread or starting a second runtime against the same desktop.
    const conversation = [...(input.conversation ?? [])];
    const task = input.task ?? await this.createTask(input, memories);
    if (this.actingAgent) return this.runWithActingAgent(input, task, memories, conversation);
    // Navigation policy is confined to the legacy requirements-first paths.
    const navigationPolicy = createBrowserNavigationPolicy(input, memories);
    if (this.orchestrator && this.worker) {
      // This guarded workflow belongs to the legacy orchestrator/worker path.
      // Production server runs use the model-led acting-agent path above.
      return this.runOrchestrated(input, task, memories, conversation, navigationPolicy);
    }
    if (!this.decisionProvider) throw new Error('A decision provider is required for the legacy runtime path.');
    const cancellation = new RunCancellation();
    const removeExternalAbort = this.attachExternalCancellation(cancellation, input.signal);
    this.activeCancellation = cancellation;
    const runId = input.runId ?? this.idFactory('run');
    this.activeRunId = runId;
    const startedAt = this.isoNow();
    const run: Run = {
      id: runId,
      threadId: task.threadId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      goal: task.goal,
      status: 'pending',
      criteria: clone(task.criteria),
      createdAt: startedAt,
    };
    const history: AgentStep[] = [];
    const steps: RunStep[] = [];
    const observations: EnvironmentObservation[] = [];
    const previousResults: ToolResult[] = [];
    let finalVerification: VerificationResult | undefined;
    let completedCriteria: string[] = [];
    let remainingCriteria = task.criteria.map(criterionKey);
    let lastToolResult: ToolResult | undefined;
    let browserContentResult: ToolResult | undefined;
    let completionCandidate: {
      actionFingerprint: string;
      verification: VerificationResult;
    } | undefined;
    const conversationalTask = task.criteria.length === 0;
    let rejectedCompletionAttempts = 0;
    const configuredMaxSteps = this.budgetOptions?.maxSteps ?? DEFAULT_RUNTIME_BUDGETS.maxSteps;
    const budget = new RunBudget({
      ...DEFAULT_RUNTIME_BUDGETS,
      ...this.budgetOptions,
      ...(task.maxSteps === undefined
        ? {}
        : { maxSteps: Math.min(configuredMaxSteps, task.maxSteps) }),
    });
    const maxRepeatedAction = this.budgetOptions?.maxRepeatedAction ?? DEFAULT_RUNTIME_BUDGETS.maxRepeatedAction;
    const actionLoopDetector = new LoopDetector(maxRepeatedAction);
    const stateLoopDetector = new LoopDetector(maxRepeatedAction);

    try {
      run.status = 'running';
      run.startedAt = startedAt;
      await this.persistRun(run, true);
      await this.emit('run.started', run, run.id);

      while (!this.isTerminal(run.status)) {
        cancellation.throwIfCancelled();
        const steering = input.drainSteering?.() ?? [];
        if (steering.length > 0) {
          conversation.push(...steering.map(message => clone(message)));
        }
        if (!budget.canStartStep()) {
          await this.fail(run, error('STEP_BUDGET_EXCEEDED', `Run exceeded its ${budget.maxSteps}-step budget.`));
          break;
        }
        const stepIndex = budget.startStep();
        const observation: EnvironmentObservation = conversationalTask
          ? {
            timestamp: this.now(),
            ...(lastToolResult ? { lastToolResult } : {}),
            task: {
              completedCriteria: [],
              remainingCriteria: [],
            },
          }
          : await this.observationProvider.observe({
            task,
            completedCriteria,
            remainingCriteria,
            lastToolResult,
            signal: cancellation.signal,
          });
        observations.push(clone(observation));
        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'observe',
          observation,
        });

        await this.emit('run.step.started', { stepIndex, observation }, run.id);
        const context: AgentTurnContext = {
          task,
          observation,
          history: clone(history),
          memories: clone(memories),
          conversation: clone(conversation),
          stepIndex,
          previousResults: clone(previousResults),
          signal: cancellation.signal,
        };
        let decision: AgentDecision = conversationalTask
          ? { type: 'complete', reasoningSummary: 'Responding to the conversation.' }
          : await this.decisionProvider!.next(context);
        if (decision.type === 'action') {
          decision = {
            ...decision,
            input: withDerivedBrowserReadQuery(decision.tool, decision.input, task, input.userMessage),
          };
        }

        // Give the model one final turn after a successful action, but do not
        // execute the same already-verified action again if it repeats it.
        if (
          completionCandidate &&
          decision.type === 'action' &&
          fingerprintAction(decision.tool, decision.input) === completionCandidate.actionFingerprint
        ) {
          await this.complete(run, completionCandidate.verification);
          await this.emit('run.step.completed', {
            observation,
            verification: completionCandidate.verification,
          }, run.id);
          break;
        }
        if (
          completionCandidate
          && decision.type === 'blocked'
        ) {
          await this.complete(run, completionCandidate.verification);
          await this.emit('run.step.completed', {
            observation,
            verification: completionCandidate.verification,
          }, run.id);
          break;
        }

        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'reason',
          decision,
          observation,
        });

        // A conversational plan has no machine-verifiable criteria and must
        // never execute a computer-use action accidentally. The final answer
        // is generated from the thread conversation after the run completes.
        if (conversationalTask && decision.type === 'action') {
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
          };
          history.push(entry);
          finalVerification = {
            complete: true,
            criteria: [],
            summary: 'Response ready.',
          };
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'complete',
            decision: { type: 'complete', reasoningSummary: decision.reasoningSummary },
            observation,
            verification: finalVerification,
          });
          await this.emit('run.verification', finalVerification, run.id);
          await this.complete(run, finalVerification);
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        if (decision.type === 'blocked') {
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
          };
          history.push(entry);
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'blocked',
            decision,
            observation,
          });
          await this.block(run, error('DECISION_BLOCKED', decision.reason));
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        if (decision.type === 'complete') {
          let verification = conversationalTask
            ? { complete: true, criteria: [], summary: 'Response ready.' }
            : await this.verify(task, observation, lastToolResult, browserContentResult);
          finalVerification = verification;
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
            verification,
          };
          history.push(entry);
          completedCriteria = verification.criteria.filter(check => check.passed).map(check => criterionKey(check.criterion));
          remainingCriteria = verification.criteria.filter(check => !check.passed).map(check => criterionKey(check.criterion));
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'complete',
            decision,
            observation,
            verification,
          });
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'verify',
            decision,
            observation,
            verification,
          });
          await this.emit('run.verification', verification, run.id);
          if (verification.complete) {
            await this.complete(run, verification);
          } else {
            completionCandidate = undefined;
            rejectedCompletionAttempts += 1;
            if (rejectedCompletionAttempts >= maxRepeatedAction) {
              await this.fail(
                run,
                error(
                  'COMPLETION_REJECTED',
                  `Helm stopped after ${rejectedCompletionAttempts} completion attempts while verification was still incomplete.`,
                ),
              );
              await this.emit('run.step.completed', entry, run.id);
              break;
            }
            lastToolResult = completionRejection(verification);
          }
          await this.emit('run.step.completed', entry, run.id);
          continue;
        }

        const entry: AgentStep = {
          reasoningSummary: decision.reasoningSummary,
          action: { tool: decision.tool, input: clone(decision.input) },
          observation,
        };
        const navigation = prepareBrowserNavigation(decision.tool, decision.input, navigationPolicy);
        let result = navigation.error
          ?? invalidBrowserNavigationResult(decision.tool, navigation.input, !conversationalTask, task)
          ?? await this.tools.execute(decision.tool, navigation.input, {
            signal: cancellation.signal,
            runId: run.id,
            stepIndex,
            previousResults,
            timeoutMs: this.budgetOptions?.toolTimeoutMs,
          });
        if (decision.tool === 'browser.navigate') {
          result = recordNavigationOutcome(result, navigation, navigationPolicy);
        } else if (decision.tool === 'browser.download') result = attachNavigationProvenance(result, navigation);
        else if (decision.tool === 'browser.open') result = recordBrowserOpenOutcome(result);
        rememberObservedBrowserUrls(decision.tool, result.data, navigationPolicy);
        if (decision.tool.startsWith('browser.') && decision.tool !== 'browser.read' && actionEffectChanged(result)) {
          browserContentResult = undefined;
        } else if (decision.tool === 'browser.read' && hasReadableBrowserContent(result)) {
          browserContentResult = result;
        }
        rejectedCompletionAttempts = 0;
        previousResults.push(clone(result));
        lastToolResult = result;
        const postActionObservation = await this.observationProvider.observe({
          task,
          completedCriteria,
          remainingCriteria,
          lastToolResult: result,
          signal: cancellation.signal,
        });
        const verification = await this.verify(task, postActionObservation, result, browserContentResult);
        finalVerification = verification;
        entry.observation = postActionObservation;
        entry.verification = verification;
        history.push(entry);
        completedCriteria = verification.criteria.filter(check => check.passed).map(check => criterionKey(check.criterion));
        remainingCriteria = verification.criteria.filter(check => !check.passed).map(check => criterionKey(check.criterion));

        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'act',
          decision,
          toolName: decision.tool,
          toolInput: decision.input,
          toolResult: result,
          observation: postActionObservation,
        });
        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'verify',
          decision,
          toolName: decision.tool,
          toolInput: decision.input,
          toolResult: result,
          observation: postActionObservation,
          verification,
        });
        await this.emit('run.verification', verification, run.id);

        if (verification.complete && result.ok) {
          completionCandidate = {
            actionFingerprint: fingerprintAction(decision.tool, decision.input),
            verification,
          };
          await this.emit('run.step.completed', entry, run.id);
          continue;
        }

        completionCandidate = undefined;

        // Detect an identical tool call independently from the observation.
        // Browser state can legitimately change between reads (loading flags,
        // window focus, and screenshot IDs), but repeating the same call with
        // the same input is still a reliable signal that the model is stuck.
        const repeatedAction = actionLoopDetector.record(fingerprintAction(
          decision.tool,
          decision.input,
        ));
        if (repeatedAction.loopDetected) {
          await this.fail(
            run,
            error(
              'TOOL_LOOP_DETECTED',
              `Helm stopped after repeating ${decision.tool} ${repeatedAction.count} times without making progress.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        const repeatedState = stateLoopDetector.record(fingerprintAction(
          decision.tool,
          decision.input,
          postActionObservation,
          result,
        ));
        if (repeatedState.loopDetected) {
          await this.fail(
            run,
            error(
              'TOOL_LOOP_DETECTED',
              `The same action produced the same state ${repeatedState.count} times.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }
        if (budget.recordToolResult(result)) {
          await this.fail(
            run,
            error(
              'TOOL_FAILURE_LIMIT',
              `Run reached ${budget.maxConsecutiveFailures} consecutive tool failures.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }
        await this.emit('run.step.completed', entry, run.id);
      }
    } catch (caught) {
      if (cancellation.cancelled || input.signal?.aborted) {
        await this.cancelled(run, error('RUN_CANCELLED', 'Run was cancelled.'));
      } else if (!this.isTerminal(run.status)) {
        await this.fail(run, error('RUNTIME_ERROR', errorMessage(caught)));
      }
    } finally {
      removeExternalAbort();
      this.activeCancellation = undefined;
      this.activeRunId = undefined;
    }

    return {
      run: clone(run),
      task: clone(task),
      history: clone(history),
      steps: clone(steps),
      observations: clone(observations),
      finalVerification: finalVerification ? clone(finalVerification) : undefined,
      status: run.status,
    };
  }

  async runTask(input: RunTaskInput): Promise<AgentRuntimeResult> {
    return this.run(input);
  }

  private async runWithActingAgent(
    input: RunTaskInput,
    task: TaskDefinition,
    memories: Memory[],
    conversation: Message[],
  ): Promise<AgentRuntimeResult> {
    const cancellation = new RunCancellation();
    const removeExternalAbort = this.attachExternalCancellation(cancellation, input.signal);
    this.activeCancellation = cancellation;
    const runId = input.runId ?? this.idFactory('run');
    this.activeRunId = runId;
    const startedAt = this.isoNow();
    let state = createTaskState(task, this.now);
    const diagnostics: RunDiagnostics = {
      modelTurns: 0,
      modelRequests: 0,
      toolActions: 0,
      completionAttempts: 0,
      completionRejections: 0,
      contextCompactions: 0,
      finalizationTurns: 0,
      lastUnsatisfiedRequirements: [],
      modelRequestOutcomes: [],
    };
    const run: Run = {
      id: runId,
      threadId: task.threadId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      goal: task.goal,
      status: 'pending',
      criteria: clone(task.criteria),
      task: clone(task),
      state: clone(state),
      diagnostics: clone(diagnostics),
      createdAt: startedAt,
    };
    const history: AgentStep[] = [];
    const steps: RunStep[] = [];
    const observations: EnvironmentObservation[] = [];
    const previousResults: ToolResult[] = [];
    const noProgress = new Map<string, { result: string; count: number }>();
    const maxToolActions = this.budgetOptions?.maxSteps ?? DEFAULT_RUNTIME_BUDGETS.maxSteps;
    const maxRepeatedAction = this.budgetOptions?.maxRepeatedAction ?? DEFAULT_RUNTIME_BUDGETS.maxRepeatedAction;
    const maxModelTurns = this.budgetOptions?.maxModelTurns ?? DEFAULT_RUNTIME_BUDGETS.maxModelTurns;
    const maxCompletionRecoveryTurns = this.budgetOptions?.maxCompletionRecoveryTurns ?? DEFAULT_RUNTIME_BUDGETS.maxCompletionRecoveryTurns;
    let actionCount = 0;
    let lastToolResult: ToolResult | undefined;
    let finalVerification: VerificationResult | undefined;
    let assistantResponse: string | undefined;
    let actionQueue: Promise<void> = Promise.resolve();

    const syncDiagnostics = (): void => {
      diagnostics.toolActions = actionCount;
      diagnostics.lastUnsatisfiedRequirements = taskRequirementSummary(state)
        .split('\n')
        .filter(line => /\[(?:pending|blocked)\]/u.test(line))
        .map(line => line.trim());
      run.diagnostics = clone(diagnostics);
    };
    const persistState = async (): Promise<void> => {
      run.task = clone(state.task);
      run.state = clone(state);
      syncDiagnostics();
      await this.persistRun(run);
    };
    const observeCurrent = async (result?: ToolResult): Promise<EnvironmentObservation> => {
      const remaining = requirementsForTask(state.task)
        .filter(requirement => !state.completedRequirementIds.includes(requirement.id))
        .map(requirement => requirement.id);
      const observation = await this.observationProvider.observe({
        task: state.task,
        completedCriteria: [...state.completedRequirementIds],
        remainingCriteria: remaining,
        ...(result ? { lastToolResult: result } : {}),
        signal: cancellation.signal,
      });
      observations.push(clone(observation));
      return observation;
    };

    const executeToolNow = async (toolName: string, modelInput: Record<string, unknown>): Promise<ToolResult> => {
      cancellation.throwIfCancelled();
      const proposedInput = clone(modelInput);
      const preparedInput = clone(modelInput);
      const stepIndex = actionCount;
      actionCount += 1;
      const action: AgentDecision = { type: 'action', tool: toolName, input: proposedInput };
      const actionKey = fingerprintAction(toolName, preparedInput);
      const previousNoProgress = noProgress.get(actionKey);
      await this.emit('run.step.started', { stepIndex, action }, runId);

      let result: ToolResult;
      const executionInput = preparedInput;
      let toolWasInvoked = false;
      const receiptStartedAt = this.isoNow();

      if (stepIndex >= maxToolActions) {
        result = { ok: false, error: { code: 'ACTION_BUDGET_EXCEEDED', message: 'The run reached its ' + maxToolActions + '-action budget.' } };
      } else if (previousNoProgress && previousNoProgress.count >= maxRepeatedAction) {
        result = { ok: false, error: { code: 'REPEATED_ACTION', message: 'This exact action has repeated without a concrete state change. Try a different valid approach.' } };
      } else {
        toolWasInvoked = true;
        await this.emit('run.progress', {
          threadId: run.threadId,
          summary: `Running ${toolName}.`,
        }, runId);
        result = await this.tools.execute(toolName, executionInput, {
          signal: cancellation.signal,
          runId,
          stepIndex,
          previousResults: clone(previousResults.slice(-12)),
          timeoutMs: this.budgetOptions?.toolTimeoutMs,
        });
        if (toolName === 'browser.open') result = recordBrowserOpenOutcome(result);
      }

      if (toolWasInvoked) {
        result = withRuntimeReceipt(toolName, executionInput, result, receiptStartedAt, this.now);
      }
      const compactResult = compactAgentToolResult(result);
      lastToolResult = compactResult;

      const resultFingerprint = fingerprintAction(toolName, executionInput, undefined, {
        ok: compactResult.ok,
        data: compactResult.data,
        error: compactResult.error,
      });
      if (actionEffectChanged(result)) {
        noProgress.delete(actionKey);
      } else {
        noProgress.set(actionKey, {
          result: resultFingerprint,
          count: previousNoProgress && previousNoProgress.result === resultFingerprint
            ? previousNoProgress.count + 1
            : 1,
        });
      }
      previousResults.push(compactResult);

      const worker = toolName.startsWith('browser.') ? 'browser'
        : toolName.startsWith('fs.') ? 'filesystem'
          : toolName.startsWith('desktop.') || toolName.startsWith('app.') ? 'desktop' : 'system';
      const workerAction = {
        id: this.idFactory('action'),
        tool: toolName,
        input: executionInput,
        result,
        ...(embeddedReceipt(result) ? { receipt: embeddedReceipt(result) } : {}),
      };
      const normalizedWorkerResult: WorkerResult = {
        status: result.ok ? 'completed' : 'failed',
        worker,
        objectiveId: 'acting-agent',
        actions: [workerAction],
        facts: observedFactsFromToolResult(result, this.now),
        evidence: [],
        artifacts: artifactsFromResult(result, this.now, workerAction),
        blockers: [],
        environmentChanged: actionEffectChanged(result),
      };
      const postObservation = await observeCurrent(compactResult);
      state = mergeWorkerResult(state, normalizedWorkerResult, postObservation, this.now);
      const verification = await verifyTaskState(task, state, this.guest, postObservation, this.verifier, compactResult);
      state = updateCompletedRequirements(state, verification);
      finalVerification = verification;
      syncDiagnostics();
      await persistState();

      await this.persistStep(steps, {
        runId,
        stepIndex,
        phase: 'act',
        decision: action,
        toolName,
        // toolInput is the input actually sent when tool execution began.
        // The model proposal remains available in decision.input.
        toolInput: clone(executionInput),
        toolResult: compactResult,
        observation: postObservation,
        verification,
      });
      history.push({
        action: { tool: toolName, input: proposedInput },
        observation: compactResult,
        verification,
      });
      await this.emit('run.verification', verification, runId);
      if (toolWasInvoked && result.ok) {
        await this.emit('run.progress', {
          threadId: run.threadId,
          summary: `Completed ${toolName}.`,
        }, runId);
      }
      const executedAction: AgentDecision = {
        type: 'action',
        tool: toolName,
        input: clone(executionInput),
      };
      await this.emit('run.step.completed', {
        stepIndex,
        action: executedAction,
        proposedTool: toolName,
        proposedInput,
        effectiveTool: toolName,
        effectiveInput: executionInput,
        toolResult: compactResult,
        verification,
      }, runId);
      return compactResult;
    };

    const executeTool = (toolName: string, toolInput: Record<string, unknown>): Promise<ToolResult> => {
      const queued = actionQueue.then(async () => {
        return executeToolNow(toolName, toolInput);
      });
      actionQueue = queued.then(() => undefined, () => undefined);
      return queued;
    };

    const verifyCompletion = async (candidate: { response: string }): Promise<ToolResult<VerificationResult>> => {
      await Promise.resolve();
      await actionQueue;
      const observation = observations.at(-1) ?? await observeCurrent(lastToolResult);
      const verification = await verifyTaskState(task, state, this.guest, observation, this.verifier, lastToolResult);
      state = updateCompletedRequirements(state, verification);
      finalVerification = verification;
      syncDiagnostics();
      await persistState();
      await this.emit('run.verification', verification, runId);
      if (verification.complete) {
        assistantResponse = candidate.response.trim();
        return { ok: true, data: verification };
      }

      const unsatisfied = (verification.requirements ?? [])
        .filter(check => check.requirement.mandatory && !check.passed)
        .map(check => ({
          id: check.requirement.id,
          message: check.message,
        }));
      const unsatisfiedCriteria = verification.criteria
        .filter(check => !check.passed)
        .map(check => ({ id: JSON.stringify(check.criterion), message: check.message }));
      const details = { requirements: unsatisfied, criteria: unsatisfiedCriteria };
      const summary = [
        ...unsatisfied.map(item => item.id + ': ' + item.message),
        ...unsatisfiedCriteria.map(item => item.id + ': ' + item.message),
      ];
      return {
        ok: false,
        error: {
          code: 'UNSATISFIED_TASK_REQUIREMENTS',
          message: 'Missing requested effects:\n' + summary.map(item => '- ' + item).join('\n'),
          details,
        },
      };
    };

    try {
      run.status = 'running';
      run.startedAt = startedAt;
      await this.persistRun(run, true);
      await this.emit('run.started', run, run.id);
      if (memories.length > 0) {
        await this.emit('run.memory.recalled', {
          threadId: run.threadId,
          count: memories.length,
        }, runId);
        const recallAction: AgentDecision = {
          type: 'action',
          tool: 'memory.recall',
          input: { count: memories.length },
        };
        const recallResult: ToolResult = { ok: true, data: { count: memories.length } };
        await this.emit('run.step.started', { stepIndex: actionCount, action: recallAction }, runId);
        await this.persistStep(steps, {
          runId,
          stepIndex: actionCount,
          phase: 'act',
          decision: recallAction,
          toolName: recallAction.tool,
          toolInput: {},
          toolResult: recallResult,
        });
        await this.emit('run.step.completed', {
          stepIndex: actionCount,
          action: recallAction,
          toolResult: recallResult,
        }, runId);
      }

      const initialObservation = await observeCurrent();
      finalVerification = await verifyTaskState(task, state, this.guest, initialObservation, this.verifier);
      state = updateCompletedRequirements(state, finalVerification);
      await persistState();

      const agentResult = await this.actingAgent!.execute({
        userMessage: input.userMessage,
        task: clone(state.task),
        conversation: clone(conversation),
        memories: clone(memories),
        toolDefinitions: this.tools.list(),
        executeTool,
        verifyCompletion,
        getRequirementSummary: () => taskRequirementSummary(state),
        getCurrentVerification: () => finalVerification,
        getToolActionCount: () => actionCount,
        onDiagnostics: async agentDiagnostics => {
          Object.assign(diagnostics, agentDiagnostics, { toolActions: actionCount });
          await persistState();
        },
        onProgress: summary => this.emit('run.progress', {
          threadId: run.threadId,
          summary,
        }, runId),
        onContextUsage: usage => this.emit('run.context.usage', {
          threadId: run.threadId,
          ...usage,
        }, runId),
        onContextCompacted: async event => {
          await this.persistStep(steps, {
            runId,
            stepIndex: actionCount,
            phase: 'observe',
            toolName: 'context.compaction',
            toolInput: { reason: event.reason },
            observation: event,
          });
          await this.emit('run.context.compacted', {
            threadId: run.threadId,
            ...event,
          }, runId);
        },
        drainSteering: input.drainSteering,
        maxToolActions,
        maxModelTurns,
        maxCompletionRecoveryTurns,
        maxRepeatedAction,
        signal: cancellation.signal,
      });
      await actionQueue;

      Object.assign(diagnostics, agentResult.diagnostics, { toolActions: actionCount });
      run.diagnostics = clone(diagnostics);
      if (!agentResult.verification.complete || !assistantResponse) {
        throw new Error('The acting model returned without a verified completion.');
      }
      finalVerification = agentResult.verification;
      assistantResponse = agentResult.response;
      await this.persistStep(steps, {
        runId,
        stepIndex: actionCount,
        phase: 'complete',
        verification: finalVerification,
      });
      await this.complete(run, finalVerification);
    } catch (caught) {
      await actionQueue;
      if (cancellation.cancelled || input.signal?.aborted) {
        await this.cancelled(run, error('RUN_CANCELLED', 'Run was cancelled.'));
      } else if (!this.isTerminal(run.status)) {
        if (finalVerification?.complete && assistantResponse) {
          try {
            if (!steps.some(step => step.phase === 'complete')) {
              await this.persistStep(steps, {
                runId,
                stepIndex: actionCount,
                phase: 'complete',
                verification: finalVerification,
              });
            }
            await this.complete(run, finalVerification);
          } catch (completionError) {
            await this.fail(run, error('ACTING_AGENT_ERROR', errorMessage(completionError)));
          }
        } else {
          const coded = isRecord(caught) && typeof caught.code === 'string'
            ? caught as { code: string; message?: unknown; details?: unknown }
            : undefined;
          await this.fail(run, error(
            coded?.code ?? 'ACTING_AGENT_ERROR',
            typeof coded?.message === 'string' ? coded.message : errorMessage(caught),
            coded?.details,
          ));
        }
      }
    } finally {
      removeExternalAbort();
      this.activeCancellation = undefined;
      this.activeRunId = undefined;
    }

    return {
      run: clone(run),
      task: clone(task),
      history: clone(history),
      steps: clone(steps),
      observations: clone(observations),
      ...(finalVerification ? { finalVerification: clone(finalVerification) } : {}),
      ...(assistantResponse ? { assistantResponse } : {}),
      status: run.status,
    };
  }

  /**
   * Execute the requirements-first loop. This path deliberately does not
   * share the legacy one-action decision loop: its model boundaries are
   * orchestrator -> bounded worker -> runtime observation -> verifier.
   */
  /** Legacy requirements-first loop retained for scripted tests and demos. */
  private async runOrchestrated(
    input: RunTaskInput,
    task: TaskDefinition,
    memories: Memory[],
    conversation: Message[],
    navigationPolicy: BrowserNavigationPolicy,
  ): Promise<AgentRuntimeResult> {
    const cancellation = new RunCancellation();
    const removeExternalAbort = this.attachExternalCancellation(cancellation, input.signal);
    this.activeCancellation = cancellation;
    const runId = input.runId ?? this.idFactory('run');
    this.activeRunId = runId;
    const startedAt = this.isoNow();
    const state = createTaskState(task, this.now);
    const conversationalTask = task.isConversation === true
      && task.criteria.length === 0
      && (task.requirements?.length ?? 0) === 0;
    const run: Run = {
      id: runId,
      threadId: task.threadId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      goal: task.goal,
      status: 'pending',
      criteria: clone(task.criteria),
      task: clone(task),
      state: clone(state),
      createdAt: startedAt,
    };
    const history: AgentStep[] = [];
    const steps: RunStep[] = [];
    const observations: EnvironmentObservation[] = [];
    let finalVerification: VerificationResult | undefined;
    let lastToolResult: ToolResult | undefined;
    let completionRejected = 0;
    const budget = new RunBudget({
      ...DEFAULT_RUNTIME_BUDGETS,
      ...this.budgetOptions,
      ...(task.maxSteps === undefined ? {} : { maxSteps: Math.min(this.budgetOptions?.maxSteps ?? DEFAULT_RUNTIME_BUDGETS.maxSteps, task.maxSteps) }),
    });
    const maxRecoveryAttempts = this.budgetOptions?.maxRecoveryAttempts ?? DEFAULT_RUNTIME_BUDGETS.maxRecoveryAttempts;
    const noProgressThreshold = this.budgetOptions?.noProgressThreshold ?? DEFAULT_RUNTIME_BUDGETS.noProgressThreshold;

    const observe = async (currentState: typeof state, result?: ToolResult): Promise<EnvironmentObservation> => {
      if (conversationalTask) {
        return {
          timestamp: this.now(),
          ...(result ? { lastToolResult: result } : {}),
          task: {
            completedCriteria: [...currentState.completedRequirementIds],
            remainingCriteria: [],
          },
        };
      }
      const observation = await this.observationProvider.observe({
        task,
        completedCriteria: currentState.completedRequirementIds,
        remainingCriteria: (currentState.task.requirements ?? []).filter(requirement => !currentState.completedRequirementIds.includes(requirement.id)).map(requirement => requirement.id),
        lastToolResult: result,
        signal: cancellation.signal,
      });
      observations.push(clone(observation));
      currentState.evidence = [...currentState.evidence, evidenceFromObservation(observation, observations.length, this.now)].slice(-80);
      currentState.currentEnvironment = compactEnvironmentObservation(observation);
      return observation;
    };

    const persistState = async (): Promise<void> => {
      run.task = clone(state.task);
      run.state = clone(state);
      await this.persistRun(run);
    };

    try {
      run.status = 'running';
      run.startedAt = startedAt;
      await this.persistRun(run, true);
      await this.emit('run.started', run, run.id);

      let observation = await observe(state);
      state.currentEnvironment = compactEnvironmentObservation(observation);
      state.progress = updateProgress(state, observation, undefined, undefined, true);
      let verification = await verifyTaskState(task, state, this.guest, observation, this.verifier, lastToolResult);
      let currentState = updateCompletedRequirements(state, verification);
      Object.assign(state, currentState);
      finalVerification = verification;
      await persistState();

      if (verification.complete) {
        await this.persistStep(steps, { runId, stepIndex: 0, phase: 'complete', observation, verification });
        await this.emit('run.verification', verification, run.id);
        await this.complete(run, verification);
        return { run: clone(run), task: clone(task), history: [], steps: clone(steps), observations: clone(observations), finalVerification: clone(verification), status: run.status };
      }

      while (!this.isTerminal(run.status)) {
        cancellation.throwIfCancelled();
        const steering = input.drainSteering?.() ?? [];
        if (steering.length > 0) conversation.push(...steering.map(message => clone(message)));
        if (!budget.canStartStep()) {
          await this.fail(run, error('STEP_BUDGET_EXCEEDED', `Run exceeded its ${budget.maxSteps}-step budget.`));
          break;
        }
        const stepIndex = budget.startStep();
        await this.emit('run.step.started', { stepIndex, observation, verification }, run.id);

        let decision: OrchestratorDecision;
        try {
          decision = await this.orchestrator!.next({
            task: clone(task),
            state: clone(state),
            observation: clone(observation),
            verification: clone(verification),
            memories: clone(memories),
            conversation: clone(conversation),
            stepIndex,
            signal: cancellation.signal,
          });
        } catch (caught) {
          decision = await new FallbackOrchestrator().next({
            task: clone(task),
            state: clone(state),
            observation: clone(observation),
            verification: clone(verification),
            memories: clone(memories),
            conversation: clone(conversation),
            stepIndex,
            signal: cancellation.signal,
          });
          state.blockers = [...state.blockers, blocker('ORCHESTRATOR_ERROR', errorMessage(caught))].slice(-12);
        }

        if (decision.type === 'objective') {
          const safeObjective = decision.objective.requirementIds.length === 1
            ? objectiveForRequirement(state, observation, decision.objective.requirementIds[0])
            : undefined;
          if (safeObjective) {
            // The runtime reconstructs the objective from compiled state so a
            // provider cannot widen the requirement or worker permission.
            decision = { ...decision, objective: { ...safeObjective, id: decision.objective.id } };
          } else {
            state.blockers = [...state.blockers, blocker('INVALID_OBJECTIVE', 'The orchestrator selected a requirement that is not currently unmet.')].slice(-12);
            decision = await new FallbackOrchestrator().next({
              task: clone(task),
              state: clone(state),
              observation: clone(observation),
              verification: clone(verification),
              memories: clone(memories),
              conversation: clone(conversation),
              stepIndex,
              signal: cancellation.signal,
            });
          }
        }

        if (decision.type === 'complete') {
          verification = await verifyTaskState(task, state, this.guest, observation, this.verifier, lastToolResult);
          finalVerification = verification;
          await this.persistStep(steps, { runId, stepIndex, phase: 'verify', orchestratorDecision: decision, observation, verification, progress: state.progress });
          await this.emit('run.verification', verification, run.id);
          if (verification.complete) {
            await persistState();
            await this.complete(run, verification);
            await this.emit('run.step.completed', { stepIndex, decision, verification }, run.id);
            break;
          }
          completionRejected += 1;
          state.blockers = [...state.blockers, blocker('COMPLETION_REJECTED', `The orchestrator proposed completion while requirements remained unmet.`, verification.requirements?.filter(check => !check.passed).map(check => check.requirement.id))].slice(-12);
          state.progress = {
            ...state.progress,
            recoveryActive: true,
            recoveryAttempts: state.progress.recoveryAttempts + 1,
            reason: 'Completion was rejected by deterministic verification.',
          };
          await persistState();
          const fallback = fallbackObjective(state, observation);
          if (fallback) {
            // Completion is a proposal, not a terminal decision. If the model
            // proposes it before verification passes, continue with the next
            // deterministic requirement objective in this same runtime turn.
            // Asking the same model for another completion proposal is the
            // failure mode that can strand otherwise actionable tasks.
            decision = {
              type: 'objective',
              objective: fallback,
              reasoningSummary: 'Completion was rejected; executing the next unmet requirement instead.',
            };
          } else if (completionRejected > maxRecoveryAttempts) {
            await this.fail(run, error('COMPLETION_REJECTED', `Completion was proposed ${completionRejected} times before all mandatory requirements were satisfied.`));
            await this.emit('run.step.completed', { stepIndex, decision, verification }, run.id);
            break;
          } else {
            await this.emit('run.step.completed', { stepIndex, decision, verification }, run.id);
            continue;
          }
        }

        if (decision.type === 'blocked') {
          const recovered = recoverOrchestratorBlocker(state, observation, decision.blocker.message);
          if (recovered) {
            state.blockers = [...state.blockers, blocker(
              'ORCHESTRATOR_BLOCKED_RECOVERED',
              decision.blocker.message,
              decision.blocker.requirementIds,
            )].slice(-12);
            decision = recovered;
          } else {
            state.blockers = [...state.blockers, decision.blocker].slice(-12);
            await persistState();
            await this.persistStep(steps, { runId, stepIndex, phase: 'blocked', orchestratorDecision: decision, observation, verification, progress: state.progress });
            await this.block(run, error(decision.blocker.code, decision.blocker.message));
            await this.emit('run.step.completed', { stepIndex, decision }, run.id);
            break;
          }
        }

        if (decision.type !== 'objective') continue;
        const objective = decision.objective;
        state.currentObjective = objective;
        const beforeFingerprint = progressFingerprint(state, observation, objective);
        let workerExecutionCount = 0;
        const maxWorkerActions = this.budgetOptions?.maxWorkerActions ?? DEFAULT_RUNTIME_BUDGETS.maxWorkerActions;
        const workerContext = {
          objective: clone(objective),
          task: clone(task),
          state: clone(state),
          observation: clone(observation),
          verification: clone(verification),
          memories: clone(memories),
          conversation: clone(conversation),
          recentActions: clone(state.recentActions),
          failedStrategies: clone(state.failedStrategies),
          maxActions: maxWorkerActions,
          signal: cancellation.signal,
          execute: {
            execute: async (tool: string, toolInput: Record<string, unknown>): Promise<ToolResult> => {
              toolInput = withDerivedBrowserReadQuery(tool, toolInput, task, input.userMessage);
              if (!allowedWorkerTool(objective.kind, tool)) {
                return { ok: false, error: { code: 'WORKER_TOOL_NOT_ALLOWED', message: `${objective.kind} worker cannot use ${tool}.` } };
              }
              if (workerExecutionCount >= maxWorkerActions) {
                return { ok: false, error: { code: 'WORKER_ACTION_BUDGET_EXCEEDED', message: `Worker exceeded its ${maxWorkerActions}-action budget.` } };
              }
              workerExecutionCount += 1;
              const navigation = prepareBrowserNavigation(tool, toolInput, navigationPolicy);
              const invalidNavigation = navigation.error ?? invalidBrowserNavigationResult(tool, navigation.input, true, task);
              if (invalidNavigation) {
                lastToolResult = invalidNavigation;
                return invalidNavigation;
              }
              let result = await this.tools.execute(tool, navigation.input, {
                signal: cancellation.signal,
                runId,
                stepIndex,
                timeoutMs: this.budgetOptions?.toolTimeoutMs,
              });
              if (tool === 'browser.navigate') {
                result = recordNavigationOutcome(result, navigation, navigationPolicy);
              } else if (tool === 'browser.download') result = attachNavigationProvenance(result, navigation);
              else if (tool === 'browser.open') result = recordBrowserOpenOutcome(result);
              rememberObservedBrowserUrls(tool, result.data, navigationPolicy);
              lastToolResult = result;
              return result;
            },
            observe: async (): Promise<EnvironmentObservation> => observe(state, lastToolResult),
            signal: cancellation.signal,
          },
        } as Parameters<WorkerProvider['execute']>[0];

        let workerResult: WorkerResult;
        try {
          workerResult = await this.worker!.execute(workerContext);
        } catch (caught) {
          workerResult = {
            status: 'failed',
            worker: objective.kind,
            objectiveId: objective.id,
            actions: [],
            facts: [],
            evidence: [],
            artifacts: [],
            blockers: [blocker('WORKER_ERROR', errorMessage(caught), objective.requirementIds)],
            environmentChanged: false,
          };
        }
        const actionLimit = maxWorkerActions;
        const cappedActions = workerResult.actions.slice(0, actionLimit);
        const actualReceiptIds = new Set(cappedActions.flatMap(action => {
          const value = typeof action.result.evidence === 'object' && action.result.evidence !== null
            ? action.result.evidence as Record<string, unknown>
            : undefined;
          const receipt = value?.receipt;
          const embeddedId = typeof receipt === 'object' && receipt !== null && typeof (receipt as { id?: unknown }).id === 'string'
            ? (receipt as { id: string }).id
            : undefined;
          return [action.receipt?.id ?? embeddedId].filter((id): id is string => id !== undefined);
        }));
        const safeEvidence = workerResult.evidence.filter(evidence => actualReceiptIds.has(evidence.id));
        const automaticFacts = cappedActions.flatMap(action => observedFactsFromToolResult(action.result, this.now));
        const safeFacts = [...workerResult.facts, ...automaticFacts].map(fact => (
          fact.origin === 'user' || fact.evidenceIds.some(id => actualReceiptIds.has(id))
            ? fact
            : { ...fact, origin: 'hypothesis' as const, confidence: 'hypothesis' as const }
        ));
        const actualArtifacts = cappedActions.flatMap(action => artifactsFromResult(action.result, this.now, action));
        const normalizedWorkerResult: WorkerResult = {
          ...workerResult,
          worker: objective.kind,
          objectiveId: objective.id,
          actions: cappedActions,
          facts: safeFacts,
          evidence: safeEvidence,
          artifacts: actualArtifacts,
          ...(workerResult.actions.length > actionLimit
            ? { blockers: [...workerResult.blockers, blocker('WORKER_ACTION_BUDGET_EXCEEDED', `Worker returned more than ${actionLimit} actions.`, objective.requirementIds)] }
            : {}),
        };
        const postObservation = await observe(state, lastToolResult);
        const merged = mergeWorkerResult(state, normalizedWorkerResult, postObservation, this.now);
        Object.assign(state, merged);
        const priorNoProgress = state.progress.noProgressStreak;
        verification = await verifyTaskState(task, state, this.guest, postObservation, this.verifier, lastToolResult);
        Object.assign(state, updateCompletedRequirements(state, verification));
        finalVerification = verification;
        const progress = updateProgress(state, postObservation, objective, beforeFingerprint);
        state.progress = progress;
        if (!progress.changed && progress.noProgressStreak >= noProgressThreshold) {
          const failed = addFailedStrategy(state, objective, normalizedWorkerResult, 'No meaningful environment or requirement state changed.', this.now);
          state.failedStrategies = [...state.failedStrategies.filter(item => item.signature !== failed.signature), failed].slice(-20);
          state.progress = {
            ...progress,
            recoveryActive: true,
            recoveryAttempts: progress.recoveryAttempts + 1,
            reason: 'Recovery required after repeated no-progress worker iterations.',
          };
          if (state.progress.recoveryAttempts > maxRecoveryAttempts) {
            state.blockers = [...state.blockers, blocker('RECOVERY_BUDGET_EXHAUSTED', `No-progress recovery was exhausted for objective ${objective.id}.`, objective.requirementIds, { previousAttempts: priorNoProgress })].slice(-12);
            await persistState();
            await this.persistStep(steps, { runId, stepIndex, phase: 'failed', orchestratorDecision: decision, objective, worker: objective.kind, workerResult: normalizedWorkerResult, observation: postObservation, verification, progress: state.progress });
            await this.fail(run, error('RECOVERY_BUDGET_EXHAUSTED', `No-progress recovery was exhausted for objective ${objective.id}.`));
            await this.emit('run.step.completed', { stepIndex, objective, workerResult: normalizedWorkerResult, verification, progress: state.progress }, run.id);
            break;
          }
        } else if (progress.changed) {
          state.progress = { ...progress, recoveryActive: false };
        }
        await persistState();
        for (const action of normalizedWorkerResult.actions) {
          history.push({
            reasoningSummary: normalizedWorkerResult.reasoningSummary,
            action: { tool: action.tool, input: clone(action.input) },
            observation: postObservation,
            verification,
          });
        }
        await this.persistStep(steps, { runId, stepIndex, phase: 'act', orchestratorDecision: decision, objective, worker: objective.kind, workerResult: normalizedWorkerResult, observation: postObservation, verification, progress: state.progress });
        await this.persistStep(steps, { runId, stepIndex, phase: 'verify', orchestratorDecision: decision, objective, worker: objective.kind, workerResult: normalizedWorkerResult, observation: postObservation, verification, progress: state.progress });
        await this.emit('run.verification', verification, run.id);
        await this.emit('run.step.completed', { stepIndex, objective, workerResult: normalizedWorkerResult, verification, progress: state.progress }, run.id);
        observation = postObservation;
        if (verification.complete) {
          await this.complete(run, verification);
          break;
        }
      }
    } catch (caught) {
      if (cancellation.cancelled || input.signal?.aborted) {
        await this.cancelled(run, error('RUN_CANCELLED', 'Run was cancelled.'));
      } else if (!this.isTerminal(run.status)) {
        await this.fail(run, error('RUNTIME_ERROR', errorMessage(caught)));
      }
    } finally {
      removeExternalAbort();
      this.activeCancellation = undefined;
      this.activeRunId = undefined;
    }

    return {
      run: clone(run),
      task: clone(task),
      history: clone(history),
      steps: clone(steps),
      observations: clone(observations),
      finalVerification: finalVerification ? clone(finalVerification) : undefined,
      status: run.status,
    };
  }

  private async createTask(input: RunTaskInput, memories: Memory[]): Promise<TaskDefinition> {
    const planner = this.taskCompiler ?? this.taskPlanner;
    if (!planner) throw new Error('A task planner is required when no task is supplied');
    return planner.createTask({
      threadId: input.threadId,
      userMessage: input.userMessage,
      conversation: clone(input.conversation ?? []),
      memories: clone(memories),
      signal: input.signal,
    });
  }

  private async loadMemories(input: MemoryRecallInput): Promise<Memory[]> {
    if (!this.memories) return [];
    try {
      return clone(typeof this.memories === 'function' ? await this.memories(input) : this.memories);
    } catch {
      // Memory is best-effort context. A retrieval failure must not prevent a
      // valid task from being planned or executed.
      return [];
    }
  }

  private async verify(
    task: TaskDefinition,
    observation: EnvironmentObservation,
    lastToolResult?: ToolResult,
    browserContentResult?: ToolResult,
  ): Promise<VerificationResult> {
    return this.verifier.verifyTask(task, {
      guest: this.guest,
      observation,
      lastToolResult,
      browserContentResult,
    });
  }

  private async persistRun(run: Run, initial = false): Promise<void> {
    if (!this.repository) return;
    if (this.repository.saveRun) await this.repository.saveRun(clone(run));
    else if (initial) await this.repository.createRun?.(clone(run));
    else await this.repository.updateRun?.(clone(run));
  }

  private async persistStep(steps: RunStep[], input: Omit<RunStep, 'id' | 'createdAt'>): Promise<void> {
    const now = this.isoNow();
    const step: RunStep = { ...input, id: this.idFactory('step'), createdAt: now, completedAt: now };
    steps.push(clone(step));
    if (this.repository?.saveStep) await this.repository.saveStep(clone(step));
    else await this.repository?.appendStep?.(clone(step));
  }

  private async emit(type: RuntimeEvent['type'], payload: unknown, runId: string): Promise<void> {
    if (!this.eventSink) return;
    const event: RuntimeEvent = {
      type,
      timestamp: this.isoNow(),
      runId,
      payload: clone(payload),
    };
    if (this.eventSink.emit) await this.eventSink.emit(event);
    else await this.eventSink.publish?.(event);
  }

  private async complete(run: Run, verification: VerificationResult): Promise<void> {
    run.status = 'completed';
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.completed', verification, run.id);
  }

  private async block(run: Run, runError: ToolError): Promise<void> {
    run.status = 'blocked';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.blocked', runError, run.id);
  }

  private async fail(run: Run, runError: ToolError): Promise<void> {
    run.status = 'failed';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.failed', runError, run.id);
  }

  private async cancelled(run: Run, runError: ToolError): Promise<void> {
    run.status = 'cancelled';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.cancelled', runError, run.id);
  }

  private isTerminal(status: Run['status']): boolean {
    return status === 'blocked' || status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private attachExternalCancellation(
    cancellation: RunCancellation,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) return () => undefined;
    const onAbort = () => cancellation.cancel();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }
}

export type Runtime = AgentRuntime;
