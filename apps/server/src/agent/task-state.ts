import { browserUrlsMatch, buildDuckDuckGoSearchUrl } from '@helm/shared';
import type {
  Artifact,
  Blocker,
  CompletionCriterion,
  CorrectiveArtifactHint,
  EnvironmentObservation,
  Evidence,
  Fact,
  FailedStrategy,
  JsonValue,
  ProgressState,
  RejectedRequirementAction,
  TaskDefinition,
  TaskRequirement,
  TaskState,
  ToolResult,
  VerificationResult,
  WorkerAction,
  WorkerObjective,
  WorkerResult,
} from '@helm/shared';

import type { GuestTransport } from '../tools/guest-transport';
import { CriterionVerifierRegistry } from '../tools/criterion-verifier';
import { isSearchEngineUrl, isSearchResultsUrl } from './browser-research';
import type { VerificationProvider } from './types';

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function compactJsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 12_000 ? value : `${value.slice(0, 11_900).trimEnd()}\n...[truncated by Helm]`;
  if (depth >= 5) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 48).map(item => compactJsonValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 64)
        .map(([key, item]) => [key, ['sourceRefs', 'documentSourceRefs'].includes(key) && Array.isArray(item)
          ? item.slice(0, 1_024).map(entry => compactJsonValue(entry, depth + 1))
          : compactJsonValue(item, depth + 1)]),
    );
  }
  return String(value);
}

function compactToolResult(result: ToolResult): ToolResult {
  return {
    ok: result.ok,
    ...(result.data === undefined ? {} : { data: compactJsonValue(result.data) }),
    ...(result.error === undefined ? {} : {
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.details === undefined ? {} : { details: compactJsonValue(result.error.details) }),
      },
    }),
    ...(result.evidence === undefined ? {} : { evidence: compactJsonValue(result.evidence) }),
  };
}

export function compactEnvironmentObservation(observation: EnvironmentObservation): EnvironmentObservation {
  return {
    ...observation,
    ...(observation.lastToolResult ? { lastToolResult: compactToolResult(observation.lastToolResult) } : {}),
  };
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function localDate(now: () => number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now()));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function criterionRequirement(criterion: CompletionCriterion, index: number): TaskRequirement {
  return {
    id: `criterion-${index + 1}`,
    description: `Satisfy ${criterion.type}.`,
    type: criterion.type.startsWith('browser') ? 'browser'
      : criterion.type.startsWith('file') ? 'filesystem'
        : criterion.type.startsWith('window') ? 'desktop' : 'semantic',
    mandatory: true,
    status: 'pending',
    criterion,
  };
}

export function requirementsForTask(task: TaskDefinition): TaskRequirement[] {
  return (task.requirements?.length ? task.requirements : task.criteria.map(criterionRequirement))
    .map(requirement => ({
      ...requirement,
      mandatory: requirement.mandatory !== false,
      status: requirement.status ?? 'pending',
    }));
}

export function validateRequirementDependencies(requirements: readonly TaskRequirement[]): void {
  const byId = new Map<string, TaskRequirement>();
  for (const requirement of requirements) {
    if (byId.has(requirement.id)) throw new Error(`Duplicate task requirement ID: ${requirement.id}`);
    byId.set(requirement.id, requirement);
  }
  for (const requirement of requirements) {
    for (const dependencyId of requirement.dependsOn ?? []) {
      if (!byId.has(dependencyId)) {
        throw new Error(`Task requirement ${requirement.id} depends on unknown requirement ${dependencyId}.`);
      }
      if (dependencyId === requirement.id) {
        throw new Error(`Task requirement ${requirement.id} cannot depend on itself.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Task requirement dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependencyId of byId.get(id)?.dependsOn ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function requirementsInDependencyOrder(requirements: readonly TaskRequirement[]): TaskRequirement[] {
  validateRequirementDependencies(requirements);
  const byId = new Map(requirements.map(requirement => [requirement.id, requirement]));
  const ordered: TaskRequirement[] = [];
  const visited = new Set<string>();
  const visit = (requirement: TaskRequirement): void => {
    if (visited.has(requirement.id)) return;
    visited.add(requirement.id);
    for (const id of requirement.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    ordered.push(requirement);
  };
  for (const requirement of requirements) visit(requirement);
  return ordered;
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.split(/[?#]/u)[0]?.toLocaleLowerCase() ?? '';
}

function navigationBasename(value: string): string {
  try {
    const url = new URL(value);
    return pathBasename(url.pathname === '/' ? url.hostname : url.pathname);
  } catch {
    return pathBasename(value);
  }
}

/** Output targets are values for filesystem/desktop workers, never browser destinations. */
export function isTaskOutputPathNavigation(task: TaskDefinition, candidate: string): boolean {
  const candidatePath = candidate.trim().toLocaleLowerCase();
  const candidateName = navigationBasename(candidate);
  return requirementsForTask(task)
    .filter(requirement => requirement.id === 'outputFile' || requirement.id === 'openFile')
    .map(requirement => requirement.target?.path)
    .filter((path): path is string => typeof path === 'string')
    .some(path => path.toLocaleLowerCase() === candidatePath || pathBasename(path) === candidateName);
}

function userFacts(task: TaskDefinition, now: () => number): { facts: Fact[]; evidence: Evidence[] } {
  const request = task.originalRequest ?? task.goal;
  const facts: Fact[] = [];
  const evidence: Evidence[] = [];
  const add = (id: string, value: JsonValue, summary: string, type: Evidence['type']): void => {
    const evidenceId = `evidence-user-${id}`;
    evidence.push({
      id: evidenceId,
      type,
      summary,
      data: value,
      source: { type },
      observedAt: iso(now),
    });
    facts.push({
      id,
      value,
      origin: type === 'user' ? 'user' : 'derived',
      confidence: type === 'user' ? 'user-provided' : 'derived',
      evidenceIds: [evidenceId],
      source: { type },
      observedAt: iso(now),
    });
  };

  const repository = request.match(/(?<![~/])\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/u)?.[1];
  if (repository && /\b(?:repo(?:sitory)?|project|github|release)\b/iu.test(request)) {
    add('repositoryName', repository, 'Repository name supplied in the user request.', 'user');
  }
  if (requirementsForTask(task).some(requirement => requirement.id === 'currentDate')) {
    add('currentDate', localDate(now), 'Current date at task start.', 'system');
  }
  return { facts, evidence };
}

export function createTaskState(task: TaskDefinition, now: () => number = Date.now): TaskState {
  const requirements = requirementsForTask(task);
  validateRequirementDependencies(requirements);
  const seeded = userFacts(task, now);
  const state: TaskState = {
    task: {
      ...task,
      requirements,
    },
    facts: seeded.facts,
    evidence: seeded.evidence,
    artifacts: [],
    completedRequirementIds: [],
    recentActions: [],
    durableActions: [],
    failedStrategies: [],
    blockers: [],
    progress: {
      fingerprint: '',
      changed: true,
      noProgressStreak: 0,
      recoveryAttempts: 0,
      recoveryActive: false,
    },
    workerResults: [],
  };
  return state;
}

export function trustedFact(facts: readonly Fact[], id: string): Fact | undefined {
  return facts.find(fact => fact.id === id && fact.origin !== 'hypothesis');
}

export function trustedFacts(facts: readonly Fact[]): Fact[] {
  return facts.filter(fact => fact.origin !== 'hypothesis');
}

/**
 * The browser owns redirect resolution. Keep the requested URL and the final
 * URL together so a redirect is treated as successful navigation rather than
 * as an instruction to submit the same URL again.
 */
export interface BrowserNavigationResolution {
  requestedUrl: string;
  finalUrl: string;
  redirected: boolean;
}

function toolResultRecord(action: WorkerAction): Record<string, unknown> | undefined {
  return action.result.data !== null
    && typeof action.result.data === 'object'
    && !Array.isArray(action.result.data)
    ? action.result.data as Record<string, unknown>
    : undefined;
}

function navigationFinalUrl(action: WorkerAction): string | undefined {
  const dataUrl = toolResultRecord(action)?.url;
  const receiptUrl = actionReceipt(action)?.effect?.urlAfter;
  if (typeof receiptUrl === 'string' && receiptUrl.length > 0) return receiptUrl;
  return typeof dataUrl === 'string' && dataUrl.length > 0 ? dataUrl : undefined;
}

/**
 * Find the most recent successful navigation from an explicit source URL.
 * `additional` is used while a bounded worker is still executing and its
 * actions have not yet been merged into TaskState.
 */
export function navigationResolutionFor(
  actions: readonly WorkerAction[],
  expectedUrl: string,
  additional: readonly BrowserNavigationResolution[] = [],
): BrowserNavigationResolution | undefined {
  for (const resolution of [...additional].reverse()) {
    if (browserUrlsMatch(resolution.requestedUrl, expectedUrl)) return resolution;
  }
  for (const action of [...actions].reverse()) {
    if (!action.tool.startsWith('browser.') || !action.result.ok) continue;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) continue;
    const navigationOccurred = action.tool === 'browser.navigate'
      || action.tool === 'browser.open'
      || receipt.effect?.navigationOccurred === true;
    if (!navigationOccurred) continue;
    const requestedUrl = receipt.effect?.requestedUrl;
    const finalUrl = receipt.effect?.urlAfter;
    if (!finalUrl) continue;
    const sourceUrl = requestedUrl ?? finalUrl;
    if (!browserUrlsMatch(sourceUrl, expectedUrl) && !browserUrlsMatch(finalUrl, expectedUrl)) continue;
    return {
      requestedUrl: sourceUrl,
      finalUrl,
      redirected: Boolean(requestedUrl && !browserUrlsMatch(requestedUrl, finalUrl)),
    };
  }
  return undefined;
}

/** Return true when the current page is either the requested URL or its known redirect target. */
export function browserDestinationReached(
  currentUrl: string | undefined,
  expectedUrl: string,
  actions: readonly WorkerAction[] = [],
  additional: readonly BrowserNavigationResolution[] = [],
): boolean {
  if (browserUrlsMatch(currentUrl, expectedUrl)) return true;
  const resolution = navigationResolutionFor(actions, expectedUrl, additional);
  return resolution !== undefined && browserUrlsMatch(currentUrl, resolution.finalUrl);
}

function factRank(fact: Fact): number {
  if (fact.source?.type === 'user' || fact.origin === 'user') return 5;
  // Runtime-owned system facts, such as the current date, must not be
  // replaced by a worker's observed-looking guess.
  if (fact.source?.type === 'system') return 4;
  return fact.origin === 'observed' ? 3 : fact.origin === 'derived' ? 2 : 1;
}

function factIsSupported(fact: Fact, evidence: readonly Evidence[]): boolean {
  if (fact.origin === 'hypothesis') return false;
  if (fact.evidenceIds.length === 0) return false;
  const linked = evidence.filter(item => fact.evidenceIds.includes(item.id));
  if (linked.length !== fact.evidenceIds.length) return false;
  const expected = json(fact.value);
  const expectedText = typeof fact.value === 'string' ? fact.value : expected.replace(/^"|"$/gu, '');
  return linked.some(item => (
    json(item.data).includes(expectedText)
    || structuredPageText(item.data) === expectedText
  ));
}

/** Exact page-read text is grounded by the structured sections in its receipt. */
function structuredPageText(value: unknown): string | undefined {
  const outer = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const data = typeof outer?.data === 'object' && outer.data !== null && !Array.isArray(outer.data)
    ? outer.data as Record<string, unknown>
    : undefined;
  const sections = Array.isArray(data?.sections) ? data.sections : undefined;
  if (!sections) return undefined;
  const text = sections.flatMap(section => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return [];
    const value = section as Record<string, unknown>;
    return typeof value.text === 'string' && value.text.trim() ? [value.text.trim()] : [];
  });
  return text.length > 0 ? text.join('\n\n') : undefined;
}

function supportedFact(state: TaskState, id: string): Fact | undefined {
  const fact = trustedFact(state.facts, id);
  if (!fact) return undefined;
  return fact.origin === 'user' || factIsSupported(fact, state.evidence) ? fact : undefined;
}

function mergeFact(existing: Fact | undefined, incoming: Fact, evidence: readonly Evidence[]): Fact {
  const supported = incoming.origin === 'user' || factIsSupported(incoming, evidence);
  const candidate: Fact = supported ? incoming : { ...incoming, origin: 'hypothesis', confidence: 'hypothesis' };
  if (!existing) return candidate;
  if (factRank(candidate) > factRank(existing)) return candidate;
  if (factRank(candidate) < factRank(existing)) return existing;
  return candidate;
}

function actualEvidenceFromResult(action: WorkerAction, now: () => number): Evidence | undefined {
  const evidence = action.result.evidence;
  if (evidence === undefined && action.receipt === undefined) return undefined;
  const evidenceRecord = typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
    ? evidence as Record<string, unknown>
    : undefined;
  const embeddedReceipt = evidenceRecord?.receipt;
  const receipt = action.receipt
    ?? (typeof embeddedReceipt === 'object' && embeddedReceipt !== null ? embeddedReceipt as NonNullable<WorkerAction['receipt']> : undefined);
  const data = evidence ?? {
    receipt,
    result: action.result.data as JsonValue,
  };
  return {
    id: receipt?.id ?? `evidence-${action.id}`,
    type: 'action',
    summary: `${action.tool} ${action.result.ok ? 'succeeded' : 'failed'}.`,
    data: compactJsonValue(data),
    source: { type: 'action', actionId: receipt?.id ?? action.id },
    observedAt: iso(now),
  };
}

function normalizedRequirementPath(value: string): string {
  return value.replace(/\\/gu, '/')
    .replace(/^\/home\/helm\//u, '~/')
    .replace(/^\/home\/helm\/workspace\//u, '')
    .replace(/^~\/(?:workspace\/)?/u, '')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/$/u, '');
}

function actionReceipt(action: WorkerAction): WorkerAction['receipt'] | undefined {
  if (action.receipt) return action.receipt;
  const evidence = recordValue(action.result.evidence);
  const receipt = recordValue(evidence?.receipt);
  return receipt as WorkerAction['receipt'] | undefined;
}

const WRITE_ACTION_TOOL_NAMES = new Set(['fs.write', 'fs.writeText', 'fs.writeFromRef']);

function actionMatchesRequirementTool(action: WorkerAction, expectedTool: string): boolean {
  return expectedTool === 'fs.write'
    ? WRITE_ACTION_TOOL_NAMES.has(action.tool)
    : action.tool === expectedTool;
}

export function requiredActionForRequirement(requirement: TaskRequirement): string | undefined {
  const target = requirement.target;
  if (target?.action) return target.action;
  switch (target?.mode) {
    case 'written':
    case 'written-from-artifact': return 'fs.write';
    case 'created': return 'fs.mkdir';
    case 'opened': return 'app.openFile';
    default: return undefined;
  }
}

/** Translate canonical receipt operations into tools exposed to the acting model. */
export function modelActionForRequirement(requirement: TaskRequirement): string | undefined {
  const action = requiredActionForRequirement(requirement);
  if (action !== 'fs.write') return action;
  return requirement.target?.mode === 'written-from-artifact' ? 'fs.writeFromRef' : 'fs.writeText';
}

function modelRecoveryActionForRequirement(requirement: TaskRequirement, state: TaskState): string | undefined {
  if (requirement.target?.mode === 'written-from-artifact'
    && !bestCorrectiveBrowserArtifact(requirement, state)) return 'browser.read';
  return modelActionForRequirement(requirement);
}

function browserVisitAction(state: TaskState, expectedUrl: string): WorkerAction | undefined {
  return [...verificationActions(state)].reverse().find(action => {
    if (!action.tool.startsWith('browser.') || !action.result.ok) return false;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
    const navigationOccurred = action.tool === 'browser.navigate'
      || action.tool === 'browser.open'
      || receipt.effect?.navigationOccurred === true;
    if (!navigationOccurred) return false;
    const requestedUrl = receipt.effect?.requestedUrl;
    const finalUrl = receipt.effect?.urlAfter;
    return [requestedUrl, finalUrl].some(value => (
      typeof value === 'string' && browserUrlsMatch(value, expectedUrl)
    ));
  });
}

function isUsableBrowserEvidenceAction(action: WorkerAction): boolean {
  if (!['browser.read', 'browser.findPage', 'browser.inspectRegion', 'browser.snapshot', 'browser.query', 'browser.evaluate'].includes(action.tool)
    || !action.result.ok) return false;
  const receipt = actionReceipt(action);
  if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
  const data = recordValue(action.result.data);
  if (!data) return false;
  if (action.tool === 'browser.read') {
    return data.readable === true && Array.isArray(data.blocks) && data.blocks.length > 0;
  }
  if (action.tool === 'browser.findPage') {
    return Number(data.matchCount) > 0 && Array.isArray(data.results) && data.results.length > 0;
  }
  if (action.tool === 'browser.inspectRegion') {
    return typeof data.text === 'string' && data.text.trim().length > 0
      || Array.isArray(data.rows) && data.rows.length > 0;
  }
  if (action.tool === 'browser.snapshot') {
    return Array.isArray(data.outline) && data.outline.length > 0
      || Array.isArray(data.elements) && data.elements.length > 0;
  }
  if (action.tool === 'browser.query') return Array.isArray(data.results) && data.results.length > 0;
  const value = data.result;
  return value !== null && value !== undefined && value !== ''
    && (!Array.isArray(value) || value.length > 0)
    && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0);
}

function browserEvidenceAction(state: TaskState): WorkerAction | undefined {
  return [...verificationActions(state)].reverse().find(isUsableBrowserEvidenceAction);
}

/** A successful current-run inspection can confirm a transiently failed navigation. */
function browserVisitEvidenceAction(
  state: TaskState,
  expectedUrl: string,
  currentUrl?: string,
): WorkerAction | undefined {
  const actions = verificationActions(state);
  const resolution = navigationResolutionFor(actions, expectedUrl);
  const currentPageReached = Boolean(currentUrl && (
    browserUrlsMatch(currentUrl, expectedUrl)
    || resolution && browserUrlsMatch(currentUrl, resolution.finalUrl)
    || actions.some(navigation => {
      if (navigation.tool !== 'browser.navigate' && navigation.tool !== 'browser.open') return false;
      const effect = actionReceipt(navigation)?.effect;
      return effect?.navigationOccurred === true
        && typeof effect.requestedUrl === 'string'
        && browserUrlsMatch(effect.requestedUrl, expectedUrl)
        && typeof effect.urlAfter === 'string'
        && browserUrlsMatch(currentUrl, effect.urlAfter);
    })
  ));
  if (!currentPageReached || !currentUrl) return undefined;
  return [...actions].reverse().find(action => {
    if (!['browser.read', 'browser.findPage', 'browser.inspectRegion', 'browser.snapshot', 'browser.query', 'browser.evaluate'].includes(action.tool)
      || !action.result.ok) return false;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
    const data = recordValue(action.result.data);
    const evidenceUrl = typeof data?.url === 'string' ? data.url : undefined;
    if (!evidenceUrl) return false;
    if (browserUrlsMatch(evidenceUrl, expectedUrl)) return true;
    if (resolution && browserUrlsMatch(evidenceUrl, resolution.finalUrl)) return true;
    return actions.some(navigation => {
      if (navigation.tool !== 'browser.navigate') return false;
      const effect = actionReceipt(navigation)?.effect;
      return typeof effect?.requestedUrl === 'string'
        && browserUrlsMatch(effect.requestedUrl, expectedUrl)
        && effect.navigationOccurred === true
        && typeof effect.urlAfter === 'string'
        && browserUrlsMatch(evidenceUrl, effect.urlAfter);
    });
  });
}

function observedSemanticContentRef(
  state: TaskState,
  writeAction: WorkerAction,
  sourceRef: string,
  sourceRevision: number,
  sourceUrl: string,
  sourceType?: string,
  writeData?: Record<string, unknown>,
): boolean {
  const actions = verificationActions(state);
  const writeIndex = actions.lastIndexOf(writeAction);
  if (writeIndex < 0) return false;
  return actions.slice(0, writeIndex).some(action => {
    if (action.tool !== 'browser.read' || !action.result.ok) return false;
    if (typeof recordValue(action.input)?.ref === 'string') return false;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
    const data = recordValue(action.result.data);
    if (data?.url !== sourceUrl || data.revision !== sourceRevision || data.sourceTruncated !== false) return false;
    const exportInfo = recordValue(data.export);
    if (exportInfo?.complete !== true || exportInfo.sourceRef !== sourceRef) return false;
    const collection = data.blocks;
    if (!Array.isArray(collection)) return false;
    if (data.documentRef === sourceRef && sourceType === 'document') {
      const diagnostics = recordValue(data.diagnostics);
      const refs = Array.isArray(data.sourceRefs)
        ? data.sourceRefs.filter((ref): ref is string => typeof ref === 'string')
        : [];
      const writtenRefs = Array.isArray(writeData?.sourceRefs)
        ? writeData.sourceRefs.filter((ref): ref is string => typeof ref === 'string')
        : [];
      const documentedRefs = Array.isArray(diagnostics?.documentSourceRefs)
        ? diagnostics.documentSourceRefs.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
      const documentBlockCount = diagnostics?.documentBlockCount;
      const documentStructuredBlockCount = diagnostics?.documentStructuredBlockCount;
      const documentTableCount = diagnostics?.documentTableCount;
      const expectedStructuredCount = data.sourceStructuredBlockCount;
      const expectedTableCount = data.sourceTableCount;
      const structuredTypes = new Set(['table', 'list', 'definition', 'form']);
      const structuredRefs = documentedRefs.filter(item => structuredTypes.has(String(item.type)));
      const tableRefs = documentedRefs.filter(item => item.type === 'table');
      if (diagnostics?.sourceTruncated === true
        || refs.length === 0
        || documentBlockCount !== refs.length
        || data.sourceTruncated !== false
        || typeof data.sourceCapturedAt !== 'string'
        || writeData?.sourceCapturedAt !== data.sourceCapturedAt
        || writeData?.sourceTruncated !== false
        || JSON.stringify(writtenRefs) !== JSON.stringify(refs)
        || expectedStructuredCount !== documentStructuredBlockCount
        || expectedTableCount !== documentTableCount
        || writeData?.sourceStructuredBlockCount !== documentStructuredBlockCount
        || writeData?.sourceTableCount !== documentTableCount
        || structuredRefs.length !== documentStructuredBlockCount
        || tableRefs.length !== documentTableCount
        || documentedRefs.length !== refs.length
        || !refs.every(ref => documentedRefs.some(item => item.ref === ref && item.includedInDocument !== false))) return false;
      return true;
    }
    const block = collection.map(recordValue).find(item => item?.ref === sourceRef);
    const sourceRefs = Array.isArray(data.sourceRefs) ? data.sourceRefs : [];
    const writtenRefs = Array.isArray(writeData?.sourceRefs) ? writeData.sourceRefs : [];
    const structuredCount = block && ['table', 'list', 'definition', 'form'].includes(String(block.type)) ? 1 : 0;
    const tableCount = block?.type === 'table' ? 1 : 0;
    return Boolean(block && isSubstantiveBrowserContentBlock(block)
      && (sourceType === undefined || block.type === sourceType)
      && typeof data.sourceCapturedAt === 'string'
      && sourceRefs.includes(sourceRef)
      && writtenRefs.length === 1 && writtenRefs[0] === sourceRef
      && writeData?.sourceStructuredBlockCount === structuredCount
      && writeData?.sourceTableCount === tableCount
      && writeData.sourceTruncated === false);
  });
}

function sourceUrlMatchesRequirement(state: TaskState, sourceUrl: string, requestedSourceUrls: readonly string[] | undefined): boolean {
  if (!requestedSourceUrls || requestedSourceUrls.length === 0) return true;
  const actions = verificationActions(state);
  return requestedSourceUrls.some(requestedUrl => {
    if (browserUrlsMatch(sourceUrl, requestedUrl)) return true;
    const resolution = navigationResolutionFor(actions, requestedUrl);
    return Boolean(resolution && browserUrlsMatch(sourceUrl, resolution.finalUrl));
  });
}

function latestNoMatchingBrowserRead(state: TaskState): {
  action: WorkerAction;
  details: Record<string, unknown>;
  message: string;
} | undefined {
  for (const action of [...verificationActions(state)].reverse()) {
    if (action.tool !== 'browser.read' || action.result.ok) continue;
    const error = recordValue(action.result.error);
    if (error?.code !== 'BROWSER_READ_NO_MATCHING_CONTENT') continue;
    const details = recordValue(error.details) ?? {};
    const pageType = typeof details.pageType === 'string' ? details.pageType : undefined;
    const query = typeof details.query === 'string' ? details.query : undefined;
    const requestedTypes = Array.isArray(details.requestedBlockTypes)
      ? details.requestedBlockTypes.filter((type): type is string => typeof type === 'string')
      : [];
    const available = recordValue(details.availableBlockTypes) ?? {};
    const availableSummary = Object.entries(available)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `${type}=${count}`)
      .join(', ');
    const parts = [
      'The latest browser.read selected no content',
      pageType ? `pageType=${pageType}` : undefined,
      query ? `query=${query}` : undefined,
      requestedTypes.length > 0 ? `requestedBlockTypes=${requestedTypes.join(',')}` : undefined,
      typeof details.tableCount === 'number' ? `tableCount=${details.tableCount}` : undefined,
      availableSummary ? `available block types: ${availableSummary}` : undefined,
      'export.complete=false; no export.sourceRef is available',
    ].filter((part): part is string => Boolean(part));
    return {
      action,
      details,
      message: `${parts.join('; ')}. Retry browser.read with a compatible selection or omit blockTypes for a general read.`,
    };
  }
  return undefined;
}

function bestCorrectiveBrowserArtifact(
  requirement: TaskRequirement,
  state: TaskState,
): CorrectiveArtifactHint | undefined {
  const candidates: Array<{ hint: CorrectiveArtifactHint; document: boolean; index: number }> = [];
  const actions = verificationActions(state);
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;
    if (action.tool !== 'browser.read' || !action.result.ok) continue;
    if (typeof recordValue(action.input)?.ref === 'string') continue;
    const receipt = actionReceipt(action);
    const data = recordValue(action.result.data);
    if (!receipt || receipt.ok !== true || receipt.tool !== 'browser.read' || !data) continue;
    const sourceUrl = typeof data.url === 'string' ? data.url : undefined;
    const sourceRevision = typeof data.revision === 'number' ? data.revision : undefined;
    const sourceCapturedAt = typeof data.sourceCapturedAt === 'string' ? data.sourceCapturedAt : undefined;
    const diagnostics = recordValue(data.diagnostics);
    const exportInfo = recordValue(data.export);
    const exportedRef = typeof exportInfo?.sourceRef === 'string' ? exportInfo.sourceRef : undefined;
    const refs = Array.isArray(data.sourceRefs)
      ? data.sourceRefs.filter((ref): ref is string => typeof ref === 'string')
      : [];
    if (!sourceUrl || sourceRevision === undefined || !sourceCapturedAt
      || data.sourceTruncated !== false || diagnostics?.sourceTruncated === true
      || exportInfo?.complete !== true || !exportedRef
      || !sourceUrlMatchesRequirement(state, sourceUrl, requirement.target?.sourceUrls)) continue;

    const documentRef = typeof data.documentRef === 'string' ? data.documentRef : undefined;
    const sourceType = typeof exportInfo.sourceType === 'string'
      ? exportInfo.sourceType
      : documentRef === exportedRef ? 'document' : undefined;
    const documentRefs = Array.isArray(diagnostics?.documentSourceRefs)
      ? diagnostics.documentSourceRefs.map(recordValue).filter((ref): ref is Record<string, unknown> => Boolean(ref))
      : [];
    const documentBlockCount = diagnostics?.documentBlockCount;
    const structuredCount = diagnostics?.documentStructuredBlockCount;
    const tableCount = diagnostics?.documentTableCount;
    const structurallyCompleteDocument = Boolean(documentRef && exportedRef === documentRef && sourceType === 'document' && refs.length > 0
      && documentBlockCount === refs.length
      && documentRefs.length === refs.length
      && documentRefs.every(ref => typeof ref.ref === 'string' && refs.includes(ref.ref))
      && typeof structuredCount === 'number'
      && typeof tableCount === 'number'
      && data.sourceStructuredBlockCount === structuredCount
      && data.sourceTableCount === tableCount);
    if (structurallyCompleteDocument && documentRef) {
      candidates.push({
        document: true,
        index,
        hint: {
          sourceRef: documentRef,
          sourceType: 'document',
          sourceUrl,
          sourceRevision,
          sourceCapturedAt,
          sourceStructuredBlockCount: structuredCount as number,
          sourceTableCount: tableCount as number,
          complete: true,
        },
      });
      continue;
    }

    if (refs.includes(exportedRef) && sourceType && sourceType !== 'document') {
      const blockCandidates = Array.isArray(data.blocks)
        ? data.blocks.map(recordValue).filter((block): block is Record<string, unknown> => Boolean(block))
        : [];
      const matchingBlock = blockCandidates.find(block => block.ref === exportedRef && block.type === sourceType);
      const structured = ['table', 'list', 'definition', 'form'].includes(sourceType);
      if (matchingBlock && !isSubstantiveBrowserContentBlock(matchingBlock)) continue;
      candidates.push({
        document: false,
        index,
        hint: {
          sourceRef: exportedRef,
          sourceType,
          sourceUrl,
          sourceRevision,
          sourceCapturedAt,
          sourceStructuredBlockCount: typeof data.sourceStructuredBlockCount === 'number' ? data.sourceStructuredBlockCount : Number(structured),
          sourceTableCount: typeof data.sourceTableCount === 'number' ? data.sourceTableCount : Number(sourceType === 'table'),
          complete: true,
        },
      });
    }
  }
  candidates.sort((left, right) => Number(right.document) - Number(left.document)
    || right.hint.sourceStructuredBlockCount - left.hint.sourceStructuredBlockCount
    || right.index - left.index);
  return candidates[0]?.hint;
}

function findRejectedArtifactWrite(
  requirement: TaskRequirement,
  state: TaskState,
): {
  reasonCode: string;
  message: string;
  correctiveTool: string;
  rejectedAction: RejectedRequirementAction;
  correctiveArtifact?: CorrectiveArtifactHint;
  recoveryEvidence?: Record<string, unknown>;
} | undefined {
  const target = requirement.target;
  if (target?.mode !== 'written-from-artifact' || !target.path) return undefined;
  const expectedPath = target.path;
  const candidate = [...verificationActions(state)].reverse().find(action => {
    if (!WRITE_ACTION_TOOL_NAMES.has(action.tool) || !action.result.ok) return false;
    const receipt = actionReceipt(action);
    const receiptPath = receipt?.effect?.path;
    return receipt?.ok === true && receipt.tool === 'fs.write'
      && receipt.effect?.writePerformed === true
      && typeof receiptPath === 'string'
      && normalizedRequirementPath(receiptPath) === normalizedRequirementPath(expectedPath);
  });
  if (!candidate) return undefined;
  const receipt = actionReceipt(candidate)!;
  const data = recordValue(candidate.result.data);
  const sourceRef = typeof data?.sourceRef === 'string' ? data.sourceRef : undefined;
  const sourceUrl = typeof data?.sourceUrl === 'string' ? data.sourceUrl : undefined;
  const correctiveArtifact = bestCorrectiveBrowserArtifact(requirement, state);
  const rejectedAction: RejectedRequirementAction = {
    tool: candidate.tool,
    path: target.path,
    ...(receipt.id ? { receiptId: receipt.id } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };

  let reasonCode: string;
  let reason: string;
  if (candidate.tool === 'fs.writeText' || !sourceRef) {
    reasonCode = 'BROWSER_PROVENANCE_REQUIRED';
    reason = `${target.path} was written with ${candidate.tool}, but this request requires raw browser-derived data with verified source provenance. Browser previews are incomplete and cannot satisfy this raw export.`;
  } else if (sourceUrl && !sourceUrlMatchesRequirement(state, sourceUrl, target.sourceUrls)) {
    reasonCode = 'SOURCE_URL_MISMATCH';
    reason = `${target.path} was written from ${sourceUrl}, which does not match the requested source${target.sourceUrls?.length === 1 ? ` ${target.sourceUrls[0]}` : ' URLs'}.`;
  } else if (data?.sourceTruncated === true) {
    reasonCode = 'BROWSER_ARTIFACT_INCOMPLETE';
    reason = `The browser artifact used for ${target.path} is marked truncated, so Helm cannot verify a complete raw-data export.`;
  } else {
    reasonCode = 'BROWSER_ARTIFACT_NOT_VERIFIED';
    reason = `The source ref used for ${target.path} does not have complete, verified current-run browser provenance.`;
  }

  const readFailure = latestNoMatchingBrowserRead(state);
  if (!correctiveArtifact) {
    reasonCode = 'NO_EXPORTABLE_BROWSER_ARTIFACT';
    reason += ' No complete current-run browser export artifact is available.';
  }
  const artifactMessage = correctiveArtifact
    ? ` A complete current-run browser artifact is available as ${correctiveArtifact.sourceRef} from ${correctiveArtifact.sourceUrl}`
      + (correctiveArtifact.sourceTableCount > 0 ? ` (${correctiveArtifact.sourceTableCount} ${correctiveArtifact.sourceTableCount === 1 ? 'table' : 'tables'})` : '')
      + (correctiveArtifact.sourceStructuredBlockCount > 0 ? ` (${correctiveArtifact.sourceStructuredBlockCount} structured blocks)` : '')
      + `; use fs.writeFromRef with that exact sourceRef to overwrite ${target.path}.`
    : ` ${readFailure?.message ?? 'Run browser.read again on the requested source until it returns export.complete=true and export.sourceRef.'} Do not call fs.writeFromRef until that complete export ref exists.`;
  return {
    reasonCode,
    message: `${reason}${artifactMessage}`,
    correctiveTool: correctiveArtifact ? 'fs.writeFromRef' : 'browser.read',
    rejectedAction,
    ...(correctiveArtifact ? { correctiveArtifact } : {}),
    ...(!correctiveArtifact ? { recoveryEvidence: {
      exportAvailable: false,
      ...(readFailure ? { latestBrowserReadFailure: readFailure.details } : {}),
    } } : {}),
  };
}

export function isSubstantiveBrowserContentBlock(block: Record<string, unknown>): boolean {
  if (block.boilerplate === true) return false;
  switch (block.type) {
    case 'table':
      return Array.isArray(block.columns) && block.columns.length > 0
        && (Array.isArray(block.rows) && block.rows.length > 0 || Number(block.rowCount) > 0);
    case 'list':
      return Array.isArray(block.items) && block.items.length > 0 || Number(block.rowCount) > 0;
    case 'definition':
      return Array.isArray(block.definitions) && block.definitions.length > 0
        || typeof block.preview === 'string' && block.preview.trim().length > 0;
    case 'form':
      return Array.isArray(block.fields) && block.fields.length > 0;
    case 'text':
    case 'code':
    case 'other':
      return (typeof block.preview === 'string' && block.preview.trim().length > 0)
        || (typeof block.text === 'string' && block.text.trim().length > 0);
    default:
      return false;
  }
}

function previouslyObservedBrowserContentRef(
  state: TaskState,
  selectedAction: WorkerAction,
  ref: string,
  url: string,
  revision: number,
): boolean {
  const actions = verificationActions(state);
  const selectedIndex = actions.lastIndexOf(selectedAction);
  if (selectedIndex < 0) {
    // Fallback to recentActions identity when durable copies differ by object identity.
    const fallbackIndex = state.recentActions.lastIndexOf(selectedAction);
    if (fallbackIndex < 0) return false;
    return state.recentActions.slice(0, fallbackIndex).some(action => {
      if (!['browser.read', 'browser.findPage', 'browser.webSearch'].includes(action.tool) || !action.result.ok) return false;
      const receipt = actionReceipt(action);
      if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
      const data = recordValue(action.result.data);
      if (data?.url !== url || data.revision !== revision) return false;
      const collection = action.tool === 'browser.read' ? data.blocks : data.results;
      return Array.isArray(collection) && collection.some(item => {
        const block = recordValue(item);
        return block?.ref === ref && isSubstantiveBrowserContentBlock(block);
      });
    });
  }
  return actions.slice(0, selectedIndex).some(action => {
    if (!['browser.read', 'browser.findPage', 'browser.webSearch'].includes(action.tool) || !action.result.ok) return false;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== action.tool) return false;
    const data = recordValue(action.result.data);
    if (data?.url !== url || data.revision !== revision) return false;
    const collection = action.tool === 'browser.read' ? data.blocks : data.results;
    return Array.isArray(collection) && collection.some(item => {
      const block = recordValue(item);
      return block?.ref === ref && isSubstantiveBrowserContentBlock(block);
    });
  });
}

function browserResearchAction(state: TaskState): WorkerAction | undefined {
  const discoveryRequired = requirementsForTask(state.task).some(requirement => (
    requirement.target?.action === 'browser.webSearch'
  ));
  return [...verificationActions(state)].reverse().find(action => {
    if (action.tool !== 'browser.read' || !action.result.ok) return false;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== 'browser.read') return false;
    const data = recordValue(action.result.data);
    if (data?.operation !== 'read' || data.readable !== true || !Array.isArray(data.blocks)) return false;
    if (discoveryRequired && isSearchEngineUrl(typeof data.url === 'string' ? data.url : undefined)) return false;
    return data.blocks.some(block => {
      const value = recordValue(block);
      return value !== undefined && isSubstantiveBrowserContentBlock(value);
    });
  });
}

/** The model-selected current page block that can be transferred losslessly. */
export function selectedBrowserArtifact(state: TaskState): {
  ref: string;
  url: string;
  revision: number;
  type: string;
} | undefined {
  for (const action of [...verificationActions(state)].reverse()) {
    if (action.tool !== 'browser.read' || !action.result.ok || typeof action.input.ref !== 'string') continue;
    const data = recordValue(action.result.data);
    if (data?.operation !== 'read' || data.readable !== true
      || typeof data.url !== 'string' || typeof data.revision !== 'number' || !Array.isArray(data.blocks)) continue;
    const block = data.blocks.map(recordValue).find(item => item?.ref === action.input.ref);
    if (!block || !isSubstantiveBrowserContentBlock(block)
      || typeof block.type !== 'string'
      || !previouslyObservedBrowserContentRef(state, action, action.input.ref, data.url, data.revision)) continue;
    return { ref: action.input.ref, url: data.url, revision: data.revision, type: block.type };
  }
  return undefined;
}

/** All actions available for verification: bounded UI buffer plus durable run-scoped successes. */
export function verificationActions(state: TaskState): WorkerAction[] {
  const seen = new Set(state.recentActions.map(action => action.id));
  const durable = (state.durableActions ?? []).filter(action => !seen.has(action.id));
  return [...durable, ...state.recentActions];
}

export interface ObservedSearchResultRef {
  ref: string;
  href: string;
}

export interface SearchDiscovery {
  action: WorkerAction;
  actionIndex: number;
  results: ObservedSearchResultRef[];
  url: string;
  query: string;
}

function searchResultsFromAction(action: WorkerAction): ObservedSearchResultRef[] | undefined {
  if (action.tool !== 'browser.webSearch' || !action.result.ok) return undefined;
  const data = recordValue(action.result.data);
  if (!data || data.searchCompleted !== true || !Array.isArray(data.results)) return undefined;
  const results = data.results.map(recordValue).flatMap(item => {
    if (!item || item.type !== 'search_result' || typeof item.ref !== 'string' || typeof item.href !== 'string') return [];
    return [{ ref: item.ref, href: item.href }];
  });
  return results.length > 0 ? results : undefined;
}

/** Most recent successful webSearch with observed result refs, searching durable evidence as well. */
export function latestSuccessfulWebSearch(state: TaskState): SearchDiscovery | undefined {
  const actions = verificationActions(state);
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;
    const results = searchResultsFromAction(action);
    if (!results) continue;
    const data = recordValue(action.result.data);
    if (typeof data?.url !== 'string' || typeof data?.query !== 'string') continue;
    return { action, actionIndex: index, results, url: data.url, query: data.query };
  }
  return undefined;
}

/** Successful browser.open actions after the latest search that opened one of its observed refs. */
export function latestOpenedSearchResult(state: TaskState, discovery?: SearchDiscovery): WorkerAction | undefined {
  const search = discovery ?? latestSuccessfulWebSearch(state);
  if (!search) return undefined;
  const refs = new Set(search.results.map(item => item.ref));
  const hrefs = search.results.map(item => item.href);
  const actions = verificationActions(state);
  for (let index = actions.length - 1; index > search.actionIndex; index -= 1) {
    const action = actions[index]!;
    if (action.tool !== 'browser.open' || !action.result.ok) continue;
    if (typeof action.input.ref === 'string' && refs.has(action.input.ref)) return action;
    const data = recordValue(action.result.data);
    const openedHref = typeof data?.openedHref === 'string' ? data.openedHref : undefined;
    if (openedHref && hrefs.some(href => {
      try { return browserUrlsMatch(openedHref, href); } catch { return openedHref === href; }
    })) return action;
  }
  return undefined;
}

/** True when a successful search exists but none of its observed results has been opened yet. */
export function hasUnopenedSearchResults(state: TaskState): boolean {
  const search = latestSuccessfulWebSearch(state);
  if (!search) return false;
  return latestOpenedSearchResult(state, search) === undefined;
}

/** Unopened observed result refs from the latest successful search. */
export function unopenedSearchResults(state: TaskState): ObservedSearchResultRef[] {
  const search = latestSuccessfulWebSearch(state);
  if (!search || latestOpenedSearchResult(state, search)) return [];
  return search.results;
}

/** Exact match of a proposed webSearch query URL against already-observed search hrefs. */
export function findObservedSearchRefForUrl(state: TaskState, query: string): string | undefined {
  const search = latestSuccessfulWebSearch(state);
  if (!search) return undefined;
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  for (const result of search.results) {
    if (trimmed === result.href) return result.ref;
    try {
      if (browserUrlsMatch(trimmed, result.href)) return result.ref;
    } catch {
      // Not a URL; continue to exact comparison only.
    }
  }
  return undefined;
}

function successfulCurrentRunAction(
  requirement: TaskRequirement,
  state: TaskState,
): { action: WorkerAction; receipt: NonNullable<WorkerAction['receipt']>; data?: Record<string, unknown> } | undefined {
  const target = requirement.target;
  const expectedTool = requiredActionForRequirement(requirement);
  if (!expectedTool || target?.freshness !== 'current-run') return undefined;
  for (const action of [...verificationActions(state)].reverse()) {
    if (!actionMatchesRequirementTool(action, expectedTool) || !action.result.ok) continue;
    const receipt = actionReceipt(action);
    if (!receipt || receipt.ok !== true || receipt.tool !== expectedTool) continue;
    const data = recordValue(action.result.data);
    const path = target.path;
    if (path) {
      const receiptPath = receipt.effect?.path;
      if (typeof receiptPath !== 'string'
        || normalizedRequirementPath(receiptPath) !== normalizedRequirementPath(path)) continue;
    }
    if (target.application) {
      const receiptApplication = receipt.effect?.application;
      if (receiptApplication !== target.application) continue;
    }
    if (expectedTool === 'fs.write' && receipt.effect?.writePerformed !== true) continue;
    if (expectedTool === 'fs.write' && target.mode === 'non-empty') {
      const bytesWritten = receipt.effect?.bytesWritten ?? data?.size;
      if (typeof bytesWritten !== 'number' || bytesWritten <= 0) continue;
    }
    if (expectedTool === 'fs.write' && target.mode === 'written-from-artifact') {
      const bytesWritten = receipt.effect?.bytesWritten ?? data?.size;
      if (typeof data?.sourceRef !== 'string'
        || typeof data.sourceType !== 'string'
        || typeof data.sourceUrl !== 'string'
        || typeof data.sourceRevision !== 'number'
        || typeof data.sourceCapturedAt !== 'string'
        || typeof bytesWritten !== 'number'
        || bytesWritten <= 0
        || !sourceUrlMatchesRequirement(state, data.sourceUrl, target.sourceUrls)
        || !observedSemanticContentRef(
          state,
          action,
          data.sourceRef,
          data.sourceRevision,
          data.sourceUrl,
          data.sourceType,
          data,
        )) continue;
    }
    if (expectedTool === 'browser.webSearch' && (
      data?.operation !== 'web_search'
      || data.searchEngine !== 'duckduckgo'
      || data.searchCompleted !== true
      || typeof data.query !== 'string'
      || typeof data.requestedUrl !== 'string'
      || typeof data.url !== 'string'
      || !isSearchResultsUrl(data.url)
      || (typeof receipt.effect?.urlAfter === 'string' && !browserUrlsMatch(data.url, receipt.effect.urlAfter))
      || !browserUrlsMatch(data.requestedUrl, buildDuckDuckGoSearchUrl(String(data.query)))
      || !Array.isArray(data.results)
      || data.results.length === 0
      || data.results.some(item => recordValue(item)?.type !== 'search_result'
        || typeof recordValue(item)?.href !== 'string'
        || typeof recordValue(item)?.ref !== 'string')
    )) continue;
    if (expectedTool === 'browser.read') {
      if (requirement.id === 'browserResearch' && !browserResearchAction(state)) continue;
      const blocks = Array.isArray(data?.blocks) ? data.blocks.map(recordValue).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
      if (data?.operation !== 'read' || data.readable !== true || !blocks.some(isSubstantiveBrowserContentBlock)) continue;
    }
    if (target.url) {
      const observedUrl = receipt.effect?.urlAfter;
      const requestedUrl = receipt.effect?.requestedUrl;
      if (
        typeof observedUrl !== 'string'
        || (typeof requestedUrl !== 'string'
          ? !browserUrlsMatch(target.url, observedUrl)
          : !browserUrlsMatch(target.url, requestedUrl) && !browserUrlsMatch(target.url, observedUrl))
      ) continue;
    }
    if (expectedTool === 'memory.remember' && receipt.effect?.changed !== true) continue;
    if (expectedTool === 'memory.update' && receipt.effect?.changed !== true) continue;
    if (expectedTool === 'memory.forget' && receipt.effect?.changed !== true) continue;
    return { action, receipt, ...(data ? { data } : {}) };
  }
  return undefined;
}

function retainEvidence(evidence: readonly Evidence[], facts: readonly Fact[]): Evidence[] {
  const requiredIds = new Set(facts.flatMap(fact => fact.evidenceIds));
  const recentIds = new Set(evidence.slice(-80).map(item => item.id));
  return evidence.filter(item => requiredIds.has(item.id) || recentIds.has(item.id));
}

export function mergeWorkerResult(
  state: TaskState,
  result: WorkerResult,
  observation: EnvironmentObservation,
  now: () => number = Date.now,
): TaskState {
  const compactActions = result.actions.map(action => ({
    ...action,
    result: compactToolResult(action.result),
  }));
  const compactEvidence = result.evidence.map(item => ({
    ...item,
    data: compactJsonValue(item.data),
  }));
  const compactResult: WorkerResult = {
    ...result,
    actions: compactActions,
    evidence: compactEvidence,
    facts: result.facts.map(fact => ({ ...fact, value: compactJsonValue(fact.value) })),
  };
  const evidence = [...state.evidence, ...compactEvidence];
  for (const action of result.actions) {
    const actual = actualEvidenceFromResult(action, now);
    if (actual && !evidence.some(item => item.id === actual.id)) evidence.push(actual);
  }
  const factMap = new Map(state.facts.map(fact => [fact.id, fact]));
  for (const fact of result.facts) {
    const incoming = {
      ...fact,
      value: compactJsonValue(fact.value),
      evidenceIds: fact.evidenceIds.filter(id => evidence.some(item => item.id === id)),
      observedAt: fact.observedAt || iso(now),
    };
    factMap.set(fact.id, mergeFact(factMap.get(fact.id), incoming, evidence));
  }
  const artifacts = [...state.artifacts];
  for (const artifact of result.artifacts) {
    if (artifacts.some(existing => existing.id === artifact.id)) continue;
    const version = Math.max(0, ...artifacts.filter(existing => existing.path === artifact.path).map(existing => existing.version ?? 1)) + 1;
    artifacts.push({ ...artifact, version });
  }
  const mergedFacts = [...factMap.values()];
  const actions = [...state.recentActions, ...compactActions].slice(-24);
  const blockers = [...state.blockers, ...result.blockers].slice(-12);
  const durableBase = state.durableActions ?? [];
  const newDurable = compactActions.filter(action => action.result.ok);
  const durableActions = [...durableBase, ...newDurable].slice(-100);
  return {
    ...state,
    facts: mergedFacts,
    evidence: retainEvidence(evidence, mergedFacts),
    artifacts: artifacts.slice(-40),
    recentActions: actions,
    durableActions,
    blockers,
    currentEnvironment: compactEnvironmentObservation(observation),
    workerResults: [...state.workerResults, compactResult].slice(-12),
  };
}

function compactBrowser(observation: EnvironmentObservation['browser']): unknown {
  if (!observation) return undefined;
  return {
    url: observation.url,
    title: observation.title,
    loading: observation.loading,
    pageCount: observation.pageCount,
    revision: observation.revision,
  };
}

export function progressFingerprint(
  state: TaskState,
  observation: EnvironmentObservation,
  objective?: WorkerObjective,
): string {
  return json({
    browser: compactBrowser(observation.browser),
    desktop: observation.desktop ? {
      focusedWindow: observation.desktop.focusedWindow,
      windows: observation.desktop.windows,
    } : undefined,
    completedRequirementIds: [...state.completedRequirementIds].sort(),
    facts: trustedFacts(state.facts)
      .map(fact => ({ id: fact.id, value: fact.value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: state.artifacts.map(artifact => ({
      path: artifact.path,
      sha256: artifact.sha256,
      sourceUrl: artifact.sourceUrl,
    })).sort((left, right) => left.path.localeCompare(right.path)),
    objective: objective?.id,
  });
}

export function updateProgress(
  state: TaskState,
  observation: EnvironmentObservation,
  objective: WorkerObjective | undefined,
  previousFingerprint: string | undefined,
  changedHint?: boolean,
): ProgressState {
  const fingerprint = progressFingerprint(state, observation, objective);
  const changed = changedHint ?? (previousFingerprint === undefined || previousFingerprint !== fingerprint);
  return {
    fingerprint,
    changed,
    noProgressStreak: changed ? 0 : state.progress.noProgressStreak + 1,
    recoveryAttempts: state.progress.recoveryAttempts,
    recoveryActive: state.progress.recoveryActive,
    reason: changed ? 'Meaningful task or environment state changed.' : 'No meaningful task or environment state changed.',
  };
}

export function strategySignature(objective: WorkerObjective, result: WorkerResult): string {
  const actions = result.actions.map(action => ({ tool: action.tool, input: action.input }));
  return json({
    kind: objective.kind,
    requirementIds: [...objective.requirementIds].sort(),
    actions,
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function criterionVerification(
  verifier: CriterionVerifierRegistry | VerificationProvider | undefined,
  task: TaskDefinition,
  guest: GuestTransport,
  observation: EnvironmentObservation,
  lastToolResult?: ToolResult,
): Promise<VerificationResult> {
  if (!verifier || task.criteria.length === 0) {
    return { complete: true, criteria: [], summary: 'No legacy completion criteria.' };
  }
  return verifier.verifyTask(task, { guest, observation, lastToolResult });
}

async function requirementCheck(
  requirement: TaskRequirement,
  state: TaskState,
  guest: GuestTransport,
  observation: EnvironmentObservation,
  verifier?: CriterionVerifierRegistry | VerificationProvider,
  lastToolResult?: ToolResult,
): Promise<{
  passed: boolean;
  message: string;
  evidence?: unknown;
  reasonCode?: string;
  correctiveTool?: string;
  rejectedAction?: RejectedRequirementAction;
  correctiveArtifact?: CorrectiveArtifactHint;
}> {
  if (requirement.id === 'browserEvidence' || requirement.target?.factId === 'pageContent') {
    const action = browserEvidenceAction(state);
    if (action) return { passed: true, message: 'Current-run browser content evidence was gathered.', evidence: action };
    const readFailure = latestNoMatchingBrowserRead(state);
    return readFailure
      ? {
          passed: false,
          reasonCode: 'BROWSER_READ_NO_MATCHING_CONTENT',
          correctiveTool: 'browser.read',
          message: `${readFailure.message} No substantive browser evidence was recorded.`,
          evidence: { latestBrowserReadFailure: readFailure.details },
        }
      : { passed: false, message: 'No successful current-run browser content inspection has been recorded.' };
  }
  if (requirement.id === 'browserResearch') {
    const action = browserResearchAction(state);
    if (action) return { passed: true, message: 'A current-run read exposed substantive page content.', evidence: action };
    const readFailure = latestNoMatchingBrowserRead(state);
    return readFailure
      ? {
          passed: false,
          reasonCode: 'BROWSER_READ_NO_MATCHING_CONTENT',
          correctiveTool: 'browser.read',
          message: `${readFailure.message} No substantive browser evidence was recorded.`,
          evidence: { latestBrowserReadFailure: readFailure.details },
        }
      : { passed: false, message: 'No current-run browser read has exposed substantive page content yet.' };
  }
  if (requirement.criterion) {
    const researchAction = requirement.criterion.type === 'custom'
      && requirement.criterion.id === 'browser.research'
      ? browserResearchAction(state)
      : undefined;
    if (
      requirement.criterion.type === 'custom'
      && requirement.criterion.id === 'browser.research'
      && researchAction
    ) {
      return {
        passed: true,
        message: 'A current-run read exposed substantive page content.',
        evidence: researchAction,
      };
    }
    if (requirement.criterion.type === 'browser.url') {
      const actions = verificationActions(state);
      const resolution = navigationResolutionFor(actions, requirement.criterion.url);
      const evidenceAction = browserVisitEvidenceAction(state, requirement.criterion.url, observation.browser?.url);
      return resolution || evidenceAction
        ? {
            passed: true,
            message: resolution?.redirected
              ? `Browser followed the redirect from ${requirement.criterion.url} to ${resolution.finalUrl}.`
              : evidenceAction
                ? `Successful current-run browser evidence confirms ${requirement.criterion.url} was reached.`
                : `Browser reached ${requirement.criterion.url}.`,
            evidence: { browser: observation.browser, navigation: resolution, action: evidenceAction },
          }
        : {
            passed: false,
            message: `No successful current-run browser navigation receipt reached ${requirement.criterion.url}.`,
            evidence: { browser: observation.browser },
          };
    }
    if (verifier) {
      const verified = await verifier.verifyTask(
        { criteria: [requirement.criterion] },
        { guest, observation, lastToolResult },
      );
      const check = verified.criteria[0];
      if (check) return check;
    }
    const criterion = state.task.criteria.find(candidate => JSON.stringify(candidate) === JSON.stringify(requirement.criterion));
    if (criterion) {
      const check = await new CriterionVerifierRegistry(guest).verifyCriterion(criterion, { observation });
      return check;
    }
  }
  const target = requirement.target ?? {};
  if (requirement.type === 'browser' && target.freshness === 'current-run' && target.url) {
    const action = browserVisitAction(state, target.url);
    const evidenceAction = browserVisitEvidenceAction(state, target.url, observation.browser?.url);
    return action || evidenceAction
      ? {
          passed: true,
          message: evidenceAction
            ? `Successful current-run browser evidence confirms the requested destination ${target.url} was reached.`
            : `The requested destination was visited during this run: ${target.url}.`,
          evidence: action ?? evidenceAction,
        }
      : { passed: false, message: `No successful current-run browser navigation or page evidence reached ${target.url}.` };
  }
  const expectedAction = requiredActionForRequirement(requirement);
  const currentAction = target.freshness === 'current-run' && expectedAction
    ? successfulCurrentRunAction(requirement, state)
    : undefined;
  if (target.freshness === 'current-run' && expectedAction && !currentAction) {
    const rejectedCandidate = expectedAction === 'fs.write'
      ? findRejectedArtifactWrite(requirement, state)
      : undefined;
    if (rejectedCandidate) {
      return {
        passed: false,
        ...rejectedCandidate,
        evidence: {
          rejectedAction: rejectedCandidate.rejectedAction,
          ...(rejectedCandidate.correctiveArtifact ? { correctiveArtifact: rejectedCandidate.correctiveArtifact } : {}),
          ...(rejectedCandidate.recoveryEvidence ? rejectedCandidate.recoveryEvidence : {}),
        },
      };
    }
    if (target.mode === 'written-from-artifact') {
      const correctiveArtifact = bestCorrectiveBrowserArtifact(requirement, state);
      if (correctiveArtifact) {
        return {
          passed: false,
          reasonCode: 'BROWSER_ARTIFACT_WRITE_REQUIRED',
          correctiveTool: 'fs.writeFromRef',
          message: `A complete current-run browser artifact is available as ${correctiveArtifact.sourceRef} from ${correctiveArtifact.sourceUrl}. Use fs.writeFromRef with that exact sourceRef to write ${target.path}.`,
          correctiveArtifact,
          evidence: { correctiveArtifact },
        };
      }
      const readFailure = latestNoMatchingBrowserRead(state);
      return {
        passed: false,
        reasonCode: 'NO_EXPORTABLE_BROWSER_ARTIFACT',
        correctiveTool: 'browser.read',
        message: `No complete current-run browser export artifact exists for ${target.path}. ${readFailure?.message ?? 'Read the requested source again until browser.read returns export.complete=true and export.sourceRef.'} Do not call fs.writeFromRef until that ref exists.`,
        evidence: {
          exportAvailable: false,
          ...(readFailure ? { latestBrowserReadFailure: readFailure.details } : {}),
        },
      };
    }
    return {
      passed: false,
      message: `A successful current-run ${expectedAction} action for ${target.path ?? requirement.id} has not been recorded.`,
    };
  }
  if (requirement.type === 'semantic' && target.freshness === 'current-run' && expectedAction) {
    return currentAction
      ? { passed: true, message: `The requested current-run ${expectedAction} action has a successful receipt.`, evidence: currentAction }
      : { passed: false, message: `A successful current-run ${expectedAction} action has not been recorded.` };
  }
  if (requirement.type === 'fact') {
    const fact = supportedFact(state, target.factId ?? requirement.id);
    return fact
      ? { passed: fact.evidenceIds.length > 0, message: `Observed fact ${fact.id}.`, evidence: fact }
      : { passed: false, message: `Fact ${target.factId ?? requirement.id} has not been observed.` };
  }
  if (requirement.type === 'artifact' || requirement.type === 'filesystem') {
    if (requirement.type === 'artifact' && target.mode === 'downloaded' && !target.path) {
      const artifact = state.artifacts.find(item => item.type === 'download' && item.download?.savedPath);
      return artifact
        ? { passed: true, message: `Download was recorded at ${artifact.path}.`, evidence: artifact }
        : { passed: false, message: 'No recorded browser download exists yet.' };
    }
    if (!target.path) return { passed: false, message: `Requirement ${requirement.id} has no concrete path.` };
    if (expectedAction === 'fs.write' && currentAction) {
      if (target.mode === 'non-empty') {
        const bytesWritten = currentAction.receipt.effect?.bytesWritten
          ?? (typeof currentAction.data?.size === 'number' ? currentAction.data.size : undefined);
        const passed = typeof bytesWritten === 'number' && bytesWritten > 0;
        return {
          passed,
          message: passed
            ? `A successful write receipt records non-empty output at ${target.path}.`
            : `The successful write receipt does not record non-empty output at ${target.path}.`,
          evidence: currentAction,
        };
      }
      if (target.mode === 'written' || target.mode === 'written-from-artifact') {
        return {
          passed: true,
          message: `A successful current-run write receipt records ${target.path}.`,
          evidence: currentAction,
        };
      }
    }
    try {
      const stat = await guest.request('fs.stat', { path: target.path });
      if (!stat.exists) return { passed: false, message: `Path does not exist: ${target.path}.`, evidence: stat };
      if (target.mode === 'written' || target.mode === 'written-from-artifact' || target.mode === 'created') {
        const passed = target.mode === 'created'
          ? stat.type === 'directory'
          : stat.type === 'file';
        return {
          passed,
          message: passed
            ? `${target.mode === 'created' ? 'Directory creation' : 'File write'} is verified for ${target.path}.`
            : `The requested current-run action did not produce the expected path type at ${target.path}.`,
          evidence: { action: currentAction, stat },
        };
      }
      if (target.mode === 'non-empty') {
        const passed = stat.type === 'file' && stat.size > 0;
        return {
          passed,
          message: passed ? `File contains output: ${target.path}.` : `File is empty or is not a regular file: ${target.path}.`,
          evidence: stat,
        };
      }
      if (target.mode === 'contains-facts') {
        const file = await guest.request('fs.read', { path: target.path });
        const missing = (target.factIds ?? []).filter(id => {
          const fact = supportedFact(state, id);
          return !fact || !file.content.includes(String(fact.value));
        });
        return {
          passed: missing.length === 0,
          message: missing.length === 0 ? `File contains all observed facts: ${target.path}.` : `File is missing observed facts: ${missing.join(', ')}.`,
          evidence: { stat, path: file.path, size: file.size, missing },
        };
      }
      if (target.mode === 'contains-text') {
        const file = await guest.request('fs.read', { path: target.path });
        const passed = target.content !== undefined && file.content.includes(target.content);
        return { passed, message: passed ? `File contains the requested text: ${target.path}.` : `File does not contain the requested text: ${target.path}.`, evidence: { path: file.path, size: file.size } };
      }
      if (target.mode === 'downloaded') {
        const artifact = state.artifacts.find(item => item.path === target.path && item.type === 'download');
        return artifact
          ? { passed: true, message: `Download was recorded at ${target.path}.`, evidence: artifact }
          : { passed: false, message: `No recorded download exists at ${target.path}.`, evidence: stat };
      }
      const pathExists = target.mode === 'exists'
        ? stat.type === 'file' || stat.type === 'directory'
        : stat.type === 'file' || (requirement.type === 'artifact' && stat.type === 'directory');
      return { passed: pathExists, message: `Path exists: ${target.path}.`, evidence: stat };
    } catch (error) {
      return { passed: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (requirement.type === 'browser') {
    if (target.freshness === 'current-run' && expectedAction === 'browser.webSearch' && currentAction) {
      return {
        passed: true,
        message: 'The requested DuckDuckGo search returned observed results during this run.',
        evidence: currentAction,
      };
    }
    const expected = target.url ?? (target.factId ? supportedFact(state, target.factId)?.value : undefined);
    const resolution = typeof expected === 'string'
      ? navigationResolutionFor(verificationActions(state), expected)
      : undefined;
    const passed = typeof expected === 'string' && browserDestinationReached(
      observation.browser?.url,
      expected,
      verificationActions(state),
    );
    return {
      passed,
      message: passed
        ? resolution?.redirected
          ? `Browser followed the redirect from ${expected} to ${resolution.finalUrl}.`
          : `Browser reached ${expected}.`
        : 'Browser has not reached the required page.',
      evidence: { browser: observation.browser, navigation: resolution },
    };
  }
  if (requirement.type === 'desktop') {
    if (expectedAction === 'app.openFile' && currentAction) {
      return {
        passed: true,
        message: `A successful current-run app.openFile receipt records ${target.path ?? requirement.id}.`,
        evidence: currentAction,
      };
    }
    const expected = target.content;
    const windows = observation.desktop?.windows ?? [];
    const stateMatches = expected === undefined || windows.some(window => window.title.includes(expected));
    return {
      passed: stateMatches && (target.freshness !== 'current-run' || Boolean(currentAction)),
      message: stateMatches
        ? target.freshness === 'current-run' ? 'The requested current-run open action and desktop state are verified.' : 'Desktop requirement is satisfied.'
        : 'Desktop requirement is not satisfied.',
      evidence: { desktop: observation.desktop, action: currentAction },
    };
  }
  return { passed: false, message: `Semantic requirement ${requirement.id} needs an explicit verifier.` };
}

export async function verifyTaskState(
  task: TaskDefinition,
  state: TaskState,
  guest: GuestTransport,
  observation: EnvironmentObservation,
  verifier?: CriterionVerifierRegistry | VerificationProvider,
  lastToolResult?: ToolResult,
): Promise<VerificationResult> {
  const legacy = await criterionVerification(verifier, task, guest, observation, lastToolResult);
  const criteria = legacy.criteria.map(check => {
    if (check.criterion.type === 'browser.url') {
      const resolution = navigationResolutionFor(verificationActions(state), check.criterion.url);
      const evidenceAction = browserVisitEvidenceAction(state, check.criterion.url, observation.browser?.url);
      return resolution || evidenceAction
        ? {
            ...check,
            passed: true,
            message: resolution?.redirected
              ? `Browser followed the redirect from ${check.criterion.url} to ${resolution.finalUrl}.`
              : evidenceAction
                ? `Successful current-run browser evidence confirms ${check.criterion.url} was reached.`
                : `Browser reached ${check.criterion.url}.`,
            evidence: { browser: observation.browser, navigation: resolution, action: evidenceAction },
          }
        : {
            ...check,
            passed: false,
            message: `No successful current-run browser navigation receipt reached ${check.criterion.url}.`,
            evidence: { browser: observation.browser },
          };
    }
    const researchAction = check.criterion.type === 'custom'
      && check.criterion.id === 'browser.research'
      ? browserResearchAction(state)
      : undefined;
    if (
      check.criterion.type === 'custom'
      && check.criterion.id === 'browser.research'
      && researchAction
    ) {
      return {
        ...check,
        passed: true,
        message: 'A current-run read exposed substantive page content.',
        evidence: researchAction,
      };
    }
    return check;
  });
  const requirements = requirementsForTask(task);
  const checksById = new Map<string, {
    requirement: TaskRequirement;
    passed: boolean;
    message: string;
    evidence?: unknown;
    reasonCode?: string;
    correctiveTool?: string;
    rejectedAction?: RejectedRequirementAction;
    correctiveArtifact?: CorrectiveArtifactHint;
  }>();
  for (const requirement of requirementsInDependencyOrder(requirements)) {
    const unsatisfiedDependencies = (requirement.dependsOn ?? [])
      .filter(id => checksById.get(id)?.passed !== true);
    const check = unsatisfiedDependencies.length > 0
      ? {
          passed: false,
          message: `Blocked by prerequisite${unsatisfiedDependencies.length === 1 ? '' : 's'}: ${unsatisfiedDependencies.join(', ')}.`,
        }
      : await requirementCheck(requirement, state, guest, observation, verifier, lastToolResult);
    checksById.set(requirement.id, { requirement, ...check });
  }
  const requirementChecks = requirements.flatMap(requirement => {
    const check = checksById.get(requirement.id);
    return check ? [check] : [];
  });
  const mandatoryRequirements = requirementChecks.filter(check => check.requirement.mandatory);
  const criteriaComplete = task.criteria.length === 0 || criteria.every(check => check.passed);
  const requirementsComplete = mandatoryRequirements.every(check => check.passed);
  const complete = criteriaComplete && requirementsComplete;
  return {
    complete,
    criteria,
    requirements: requirementChecks,
    summary: complete
      ? 'All mandatory requirements and deterministic criteria are satisfied.'
      : `${requirementChecks.filter(check => check.passed).length}/${requirementChecks.length} requirements and ${criteria.filter(check => check.passed).length}/${criteria.length} legacy criteria passed.`,
  };
}

export function updateCompletedRequirements(state: TaskState, verification: VerificationResult): TaskState {
  const completed = verification.requirements?.filter(check => check.passed).map(check => check.requirement.id) ?? [];
  const completedSet = new Set(completed);
  return {
    ...state,
    completedRequirementIds: completed,
    task: {
      ...state.task,
      requirements: requirementsForTask(state.task).map(requirement => ({
        ...requirement,
        status: completedSet.has(requirement.id)
          ? 'satisfied'
          : (requirement.dependsOn ?? []).some(id => !completedSet.has(id)) ? 'blocked' : 'pending',
      })),
    },
  };
}

/** A short runtime-owned progress view for the acting model's next turn. */
export function taskRequirementSummary(state: TaskState): string {
  const lines = requirementsForTask(state.task).map(requirement => {
    const status = state.completedRequirementIds.includes(requirement.id)
      ? 'satisfied'
      : (requirement.dependsOn ?? []).some(id => !state.completedRequirementIds.includes(id))
        ? 'blocked'
        : 'pending';
    const target = requirement.target;
    const modelAction = modelRecoveryActionForRequirement(requirement, state);
    const fields = [
      ...(target?.path ? [`path=${target.path}`] : []),
      ...(target?.mode ? [`mode=${target.mode}`] : []),
      ...(modelAction ? [`action=${modelAction}`] : []),
      ...(target?.application ? [`application=${target.application}`] : []),
      ...(target?.url ? [`url=${target.url}`] : []),
      ...(target?.sourceUrls?.[0] ? [`sourceUrl=${target.sourceUrls[0]}`] : []),
      ...(target?.factId ? [`fact=${target.factId}`] : []),
    ];
    const targetSummary = fields.length > 0 ? ` ${fields.join(' ')}` : '';
    const dependencies = status === 'blocked' ? ` dependsOn=${(requirement.dependsOn ?? []).filter(id => !state.completedRequirementIds.includes(id)).join(',')}` : '';
    return `- [${status}] ${requirement.id}${targetSummary}${dependencies}`;
  });
  if (hasUnopenedSearchResults(state)) {
    const unopened = unopenedSearchResults(state);
    const searchLineIndex = lines.findIndex(line => line.includes('browserSearch'));
    const derived = `- [pending] searchResultOpen observed results: ${unopened.length} allowed action: browser.open`;
    if (searchLineIndex >= 0) lines.splice(searchLineIndex + 1, 0, derived);
    else lines.push(derived);
  } else {
    const opened = latestOpenedSearchResult(state);
    if (opened && latestSuccessfulWebSearch(state)) {
      const searchLineIndex = lines.findIndex(line => line.includes('browserSearch'));
      if (searchLineIndex >= 0) {
        const existing = lines.find(line => line.includes('searchResultOpen'));
        if (!existing) lines.splice(searchLineIndex + 1, 0, '- [satisfied] searchResultOpen');
      }
    }
  }
  return lines.join('\n');
}

export function blocker(code: string, message: string, requirementIds?: string[], details?: JsonValue): Blocker {
  return {
    code,
    message,
    ...(requirementIds === undefined ? {} : { requirementIds }),
    ...(details === undefined ? {} : { details }),
  };
}

export function addFailedStrategy(
  state: TaskState,
  objective: WorkerObjective,
  result: WorkerResult,
  reason: string,
  now: () => number = Date.now,
): FailedStrategy {
  const signature = strategySignature(objective, result);
  return {
    signature,
    objectiveId: objective.id,
    description: objective.description,
    reason,
    attempts: (state.failedStrategies.find(item => item.signature === signature)?.attempts ?? 0) + 1,
    recordedAt: iso(now),
  };
}

export function toolEvidence(result: ToolResult, tool: string, now: () => number = Date.now): Evidence | undefined {
  if (result.evidence === undefined) return undefined;
  const data = result.evidence as JsonValue;
  return {
    id: `evidence-tool-${tool}-${now()}`,
    type: 'action',
    summary: `${tool} returned an action receipt.`,
    data,
    source: { type: 'action' },
    observedAt: iso(now),
  };
}

export function evidenceFromObservation(observation: EnvironmentObservation, sequence: number, now: () => number = Date.now): Evidence {
  const id = `evidence-observation-${now()}-${sequence}`;
  const type = observation.browser ? 'browser' : observation.desktop ? 'desktop' : 'system';
  return {
    id,
    type,
    summary: 'Runtime environment observation.',
    data: compactJsonValue(observation),
    source: {
      type,
      observationId: id,
      ...(observation.browser?.url ? { url: observation.browser.url } : {}),
    },
    observedAt: iso(now),
  };
}

export function artifactsFromResult(
  result: ToolResult,
  now: () => number = Date.now,
  action?: WorkerAction,
): Artifact[] {
  const data = recordValue(result.data);
  const evidence = recordValue(result.evidence);
  const receipt = action?.receipt ?? recordValue(evidence?.receipt) as WorkerAction['receipt'] | undefined;
  const download = recordValue(data?.download) ?? (typeof data?.sourceUrl === 'string' ? data : undefined);
  if (download && typeof download.savedPath === 'string') {
    return [{
      id: receipt?.id ? `artifact-${receipt.id}` : `artifact-download-${download.savedPath}-${now()}`,
      type: 'download',
      path: download.savedPath,
      ...(typeof download.size === 'number' ? { size: download.size } : {}),
      ...(typeof download.sourceUrl === 'string' ? { sourceUrl: download.sourceUrl } : {}),
      download: download as unknown as Artifact['download'],
      observedAt: iso(now),
    }];
  }
  if (result.ok && typeof data?.path === 'string' && (typeof data.existsAfter === 'boolean' || typeof data.sha256 === 'string')) {
    return [{
      id: receipt?.id ? `artifact-${receipt.id}` : `artifact-write-${data.path}-${now()}`,
      type: 'file',
      path: data.path,
      ...(typeof data.size === 'number' ? { size: data.size } : typeof data.bytesWritten === 'number' ? { size: data.bytesWritten } : {}),
      ...(typeof data.sha256 === 'string' ? { sha256: data.sha256 } : {}),
      ...(typeof data.sourceUrl === 'string' ? { sourceUrl: data.sourceUrl } : {}),
      ...(typeof data.sourceRef === 'string' ? { sourceRef: data.sourceRef } : {}),
      ...(typeof data.sourceType === 'string' ? { sourceType: data.sourceType as Artifact['sourceType'] } : {}),
      ...(typeof data.sourceRevision === 'number' ? { sourceRevision: data.sourceRevision } : {}),
      ...(typeof data.sourceCapturedAt === 'string' ? { sourceCapturedAt: data.sourceCapturedAt } : {}),
      ...(Array.isArray(data.sourceRefs) ? { sourceRefs: data.sourceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 100) } : {}),
      ...(typeof data.sourceStructuredBlockCount === 'number' ? { sourceStructuredBlockCount: data.sourceStructuredBlockCount } : {}),
      ...(typeof data.sourceTableCount === 'number' ? { sourceTableCount: data.sourceTableCount } : {}),
      ...(typeof data.sourceTruncated === 'boolean' ? { sourceTruncated: data.sourceTruncated } : {}),
      ...(typeof data.format === 'string' ? { format: data.format as Artifact['format'] } : {}),
      ...(receipt?.id ? { writeReceiptId: receipt.id } : {}),
      observedAt: iso(now),
    }];
  }
  return [];
}

/** Facts whose values are directly present in a successful tool response. */
export function observedFactsFromToolResult(result: ToolResult, now: () => number = Date.now): Fact[] {
  if (!result.ok || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) return [];
  const data = result.data as Record<string, unknown>;
  const evidence = typeof result.evidence === 'object' && result.evidence !== null
    ? result.evidence as Record<string, unknown>
    : undefined;
  const receipt = evidence?.receipt;
  const evidenceId = typeof receipt === 'object' && receipt !== null && typeof (receipt as { id?: unknown }).id === 'string'
    ? (receipt as { id: string }).id
    : undefined;
  const source = evidenceId ? { type: 'action' as const, actionId: evidenceId } : { type: 'action' as const };
  const observedAt = iso(now);
  const facts: Fact[] = [];
  const readSections = Array.isArray(data.sections)
    ? data.sections.flatMap(section => {
      if (typeof section !== 'object' || section === null || Array.isArray(section)) return [];
      const value = section as Record<string, unknown>;
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      return text ? [text] : [];
    }).join('\n\n')
    : '';
  const pageText = typeof data.text === 'string' ? data.text : readSections;
  if (pageText.trim().length > 0) {
    facts.push({ id: 'pageContent', value: pageText.slice(0, 12_000), origin: 'observed', confidence: 'observed', evidenceIds: evidenceId ? [evidenceId] : [], source, observedAt });
  }
  if (typeof data.url === 'string' && data.url.length > 0) {
    facts.push({ id: 'currentPageUrl', value: data.url, origin: 'observed', confidence: 'observed', evidenceIds: evidenceId ? [evidenceId] : [], source, observedAt });
  }
  if (typeof data.sourceUrl === 'string' && data.sourceUrl.length > 0) {
    facts.push({ id: 'downloadSourceUrl', value: data.sourceUrl, origin: 'observed', confidence: 'observed', evidenceIds: evidenceId ? [evidenceId] : [], source, observedAt });
  }
  return facts;
}
