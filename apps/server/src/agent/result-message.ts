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

function boundedText(value: string): string {
  if (value.length <= MAX_RESULT_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_RESULT_MESSAGE_LENGTH - 40).trimEnd()}\n\n[Output truncated by Helm.]`;
}

/** Turn useful verified tool output into the assistant's user-facing reply. */
export function assistantMessageForResult(result: AgentRuntimeResult): string {
  if (result.status !== 'completed') {
    return result.run.error?.message ?? `Task ended with status: ${result.status}.`;
  }

  const extracted = [...result.steps].reverse()
    .map(step => successfulData(step, 'browser.extractText'))
    .find((data): data is Record<string, unknown> => data !== undefined)
    ?? successfulWorkerData(result, 'browser.extractText');
  if (extracted) {
    const title = typeof extracted.title === 'string' ? extracted.title.trim() : '';
    const url = typeof extracted.url === 'string' ? extracted.url.trim() : '';
    const source = title || url ? `I read ${title || url}${title && url ? ` (${url})` : ''}.` : 'I read the page.';
    const text = typeof extracted.text === 'string' ? extracted.text.trim() : '';
    return `${source}\n\n${text ? boundedText(text) : 'The page did not contain readable text.'}`;
  }

  const file = [...result.steps].reverse()
    .map(step => successfulData(step, 'fs.read'))
    .find((data): data is Record<string, unknown> => data !== undefined)
    ?? successfulWorkerData(result, 'fs.read');
  if (file && typeof file.content === 'string') {
    const path = typeof file.path === 'string' ? file.path : 'the requested file';
    return `Here is ${path}:\n\n${boundedText(file.content)}`;
  }

  if (result.task.criteria.length === 0 && (result.task.requirements?.length ?? 0) === 0) {
    return 'I’m Helm, a local desktop agent. I can browse websites, work with files, and interact with the controlled desktop.';
  }

  return result.finalVerification?.summary ?? 'Task completed and verified.';
}
