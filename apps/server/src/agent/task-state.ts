import { browserUrlsMatch } from '@helm/shared';
import type {
  Artifact,
  Blocker,
  CompletionCriterion,
  EnvironmentObservation,
  Evidence,
  Fact,
  FailedStrategy,
  JsonValue,
  ProgressState,
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
        .map(([key, item]) => [key, compactJsonValue(item, depth + 1)]),
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
  if (typeof dataUrl === 'string' && dataUrl.length > 0) return dataUrl;
  const receiptUrl = action.receipt?.effect?.urlAfter;
  return typeof receiptUrl === 'string' && receiptUrl.length > 0 ? receiptUrl : undefined;
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
    if (action.tool !== 'browser.navigate' || !action.result.ok) continue;
    const requestedUrl = typeof action.input.url === 'string' ? action.input.url : undefined;
    const finalUrl = navigationFinalUrl(action);
    if (!requestedUrl || !finalUrl || !browserUrlsMatch(requestedUrl, expectedUrl)) continue;
    return {
      requestedUrl,
      finalUrl,
      redirected: !browserUrlsMatch(requestedUrl, finalUrl),
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
  const expectedText = expected.replace(/^"|"$/gu, '');
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
    if (!artifacts.some(existing => existing.id === artifact.id || existing.path === artifact.path)) {
      artifacts.push(artifact);
    }
  }
  const mergedFacts = [...factMap.values()];
  const actions = [...state.recentActions, ...compactActions].slice(-24);
  const blockers = [...state.blockers, ...result.blockers].slice(-12);
  return {
    ...state,
    facts: mergedFacts,
    evidence: retainEvidence(evidence, mergedFacts),
    artifacts: artifacts.slice(-40),
    recentActions: actions,
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
): Promise<{ passed: boolean; message: string; evidence?: unknown }> {
  if (requirement.criterion) {
    if (
      requirement.criterion.type === 'custom'
      && requirement.criterion.id === 'browser.research'
      && supportedFact(state, 'pageContent')
    ) {
      return {
        passed: true,
        message: 'Readable web page content is present in observed evidence.',
        evidence: supportedFact(state, 'pageContent'),
      };
    }
    if (
      requirement.criterion.type === 'browser.url'
      && browserDestinationReached(
        observation.browser?.url,
        requirement.criterion.url,
        state.recentActions,
      )
    ) {
      const resolution = navigationResolutionFor(state.recentActions, requirement.criterion.url);
      return {
        passed: true,
        message: resolution?.redirected
          ? `Browser followed the redirect from ${requirement.criterion.url} to ${resolution.finalUrl}.`
          : `Browser reached ${requirement.criterion.url}.`,
        evidence: { browser: observation.browser, navigation: resolution },
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
    try {
      const stat = await guest.request('fs.stat', { path: target.path });
      if (!stat.exists) return { passed: false, message: `Path does not exist: ${target.path}.`, evidence: stat };
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
    const expected = target.url ?? (target.factId ? supportedFact(state, target.factId)?.value : undefined);
    const resolution = typeof expected === 'string'
      ? navigationResolutionFor(state.recentActions, expected)
      : undefined;
    const passed = typeof expected === 'string' && browserDestinationReached(
      observation.browser?.url,
      expected,
      state.recentActions,
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
    const expected = target.content;
    const windows = observation.desktop?.windows ?? [];
    const passed = expected === undefined || windows.some(window => window.title.includes(expected));
    return { passed, message: passed ? 'Desktop requirement is satisfied.' : 'Desktop requirement is not satisfied.', evidence: observation.desktop };
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
    if (
      check.criterion.type === 'custom'
      && check.criterion.id === 'browser.research'
      && supportedFact(state, 'pageContent')
    ) {
      return {
        ...check,
        passed: true,
        message: 'Readable web page content is present in observed evidence.',
        evidence: supportedFact(state, 'pageContent'),
      };
    }
    if (
      !check.passed
      && check.criterion.type === 'browser.url'
      && browserDestinationReached(observation.browser?.url, check.criterion.url, state.recentActions)
    ) {
      const resolution = navigationResolutionFor(state.recentActions, check.criterion.url);
      return {
        ...check,
        passed: true,
        message: resolution?.redirected
          ? `Browser followed the redirect from ${check.criterion.url} to ${resolution.finalUrl}.`
          : `Browser reached ${check.criterion.url}.`,
        evidence: { browser: observation.browser, navigation: resolution },
      };
    }
    return check;
  });
  const requirements = await Promise.all(requirementsForTask(task).map(async requirement => {
    const check = await requirementCheck(requirement, state, guest, observation, verifier, lastToolResult);
    return { requirement, ...check };
  }));
  const mandatoryRequirements = requirements.filter(check => check.requirement.mandatory);
  const criteriaComplete = task.criteria.length === 0 || criteria.every(check => check.passed);
  const requirementsComplete = mandatoryRequirements.every(check => check.passed);
  const complete = criteriaComplete && requirementsComplete;
  return {
    complete,
    criteria,
    requirements,
    summary: complete
      ? 'All mandatory requirements and deterministic criteria are satisfied.'
      : `${requirements.filter(check => check.passed).length}/${requirements.length} requirements and ${criteria.filter(check => check.passed).length}/${criteria.length} legacy criteria passed.`,
  };
}

export function updateCompletedRequirements(state: TaskState, verification: VerificationResult): TaskState {
  const completed = verification.requirements?.filter(check => check.passed).map(check => check.requirement.id) ?? [];
  return {
    ...state,
    completedRequirementIds: completed,
    task: {
      ...state.task,
      requirements: requirementsForTask(state.task).map(requirement => ({
        ...requirement,
        status: completed.includes(requirement.id) ? 'satisfied' : 'pending',
      })),
    },
  };
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

export function artifactsFromResult(result: ToolResult, now: () => number = Date.now): Artifact[] {
  const data = recordValue(result.data);
  const download = recordValue(data?.download) ?? (typeof data?.sourceUrl === 'string' ? data : undefined);
  if (download && typeof download.savedPath === 'string') {
    return [{
      id: `artifact-${download.savedPath}`,
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
      id: `artifact-${data.path}`,
      type: 'file',
      path: data.path,
      ...(typeof data.bytesWritten === 'number' ? { size: data.bytesWritten } : {}),
      ...(typeof data.sha256 === 'string' ? { sha256: data.sha256 } : {}),
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
