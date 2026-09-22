import type { AgentRuntimeResult, RunStep } from './types';

const MAX_RESULT_MESSAGE_LENGTH = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function successfulData(step: RunStep, toolName: string): Record<string, unknown> | undefined {
  if (step.phase !== 'act' || step.toolName !== toolName || step.toolResult?.ok !== true) {
    return undefined;
  }
  return isRecord(step.toolResult.data) ? step.toolResult.data : undefined;
}

function successfulWorkerData(result: AgentRuntimeResult, toolName: string): Record<string, unknown> | undefined {
  for (const step of [...result.steps].reverse()) {
    const action = [...(step.workerResult?.actions ?? [])].reverse().find(candidate => candidate.tool === toolName && candidate.result.ok);
    if (action && isRecord(action.result.data)) return action.result.data;
  }
  return undefined;
}

function successfulToolData(result: AgentRuntimeResult, toolName: string): Record<string, unknown> | undefined {
  return [...result.steps].reverse()
    .map(step => successfulData(step, toolName))
    .find((data): data is Record<string, unknown> => data !== undefined)
    ?? successfulWorkerData(result, toolName);
}

function hasSuccessfulAction(result: AgentRuntimeResult, toolNames?: readonly string[]): boolean {
  return result.steps.some(step => (
    step.phase === 'act'
    && step.toolName !== undefined
    && step.toolResult?.ok === true
    && (toolNames === undefined || toolNames.includes(step.toolName))
  )) || result.steps.some(step => (
    step.workerResult?.actions.some(action => (
      action.result.ok
      && (toolNames === undefined || toolNames.includes(action.tool))
    )) ?? false
  ));
}

/** Whether a completed task has an observed action that can ground a reply. */
export function hasVerifiedActionEvidence(result: AgentRuntimeResult): boolean {
  return hasSuccessfulAction(result)
    || (result.run.state?.facts.length ?? 0) > 0
    || (result.run.state?.artifacts.length ?? 0) > 0;
}

/** File/viewer operations are better reported from their receipts than from a model rewrite. */
export function hasDeterministicFileEvidence(result: AgentRuntimeResult): boolean {
  return hasSuccessfulAction(result, ['fs.read', 'fs.write', 'app.openFile']);
}

export function isUnsubstantiatedPlaceholder(value: string): boolean {
  return /\b(?:would be displayed here|if the artifact were available|artifact (?:is )?available|content .* would be displayed)\b/iu.test(value);
}

function boundedText(value: string): string {
  if (value.length <= MAX_RESULT_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_RESULT_MESSAGE_LENGTH - 40).trimEnd()}\n\n[Output truncated by Helm.]`;
}

/** Turn useful verified tool output into the assistant's user-facing reply. */
export function assistantMessageForResult(result: AgentRuntimeResult): string {
  if (result.status !== 'completed') {
    return result.run.error?.message ?? `Task ended with status: ${result.status}.`;
  }

  const opened = successfulToolData(result, 'app.openFile');
  if (opened) {
    const path = typeof opened.path === 'string' ? opened.path : 'the requested file';
    const application = typeof opened.application === 'string' ? opened.application : 'text viewer';
    const applicationLabel = application === 'text-editor' ? 'the text viewer' : application;
    return `Opened ${path} in ${applicationLabel}.`;
  }

  const file = successfulToolData(result, 'fs.read');
  if (file && typeof file.content === 'string') {
    const path = typeof file.path === 'string' ? file.path : 'the requested file';
    return `Here is ${path}:\n\n${boundedText(file.content)}`;
  }

  const written = successfulToolData(result, 'fs.write');
  if (written) {
    const path = typeof written.path === 'string' ? written.path : 'the requested file';
    const size = typeof written.size === 'number' ? ` (${written.size} bytes)` : '';
    return `Saved ${path}${size}.`;
  }

  const extracted = successfulToolData(result, 'browser.extractText');
  if (extracted) {
    const title = typeof extracted.title === 'string' ? extracted.title.trim() : '';
    const url = typeof extracted.url === 'string' ? extracted.url.trim() : '';
    const source = title || url ? `I read ${title || url}${title && url ? ` (${url})` : ''}.` : 'I read the page.';
    const text = typeof extracted.text === 'string' ? extracted.text.trim() : '';
    return `${source}\n\n${text ? boundedText(text) : 'The page did not contain readable text.'}`;
  }

  if (result.task.criteria.length === 0 && (result.task.requirements?.length ?? 0) === 0) {
    return 'I’m Helm, a local desktop agent. I can browse websites, work with files, and interact with the controlled desktop.';
  }

  return result.finalVerification?.summary ?? 'Task completed and verified.';
}
