import type { CompletionCriterion } from '@helm/shared';
import type { HelmEvent, RunActivityEventHistory, RunDetails, RunStep } from './types';

const MAX_STRING_CHARS = 20_000;
const MAX_VALUE_CHARS = 50_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_OBJECT_KEYS = 500;
const MAX_NESTING_DEPTH = 18;
const MAX_LOG_CHARS = 2_000_000;

type FormatOptions = {
  historySource?: 'server' | 'local';
  historyRefreshWarning?: string;
  runtimeEvents?: RunActivityEventHistory;
};

type TimelineEntry = {
  timestamp?: string;
  timestampOrder: number;
  insertionOrder: number;
  label: string;
  body: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omittedBinary(value: unknown, key: string): string | undefined {
  if (value instanceof ArrayBuffer) return `<omitted binary payload: ${value.byteLength} bytes>`;
  if (ArrayBuffer.isView(value)) return `<omitted binary payload: ${value.byteLength} bytes>`;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `<omitted binary payload: ${value.size} bytes>`;
  if (typeof value !== 'string' || value.length === 0) return undefined;

  const normalizedKey = key.toLowerCase();
  if (/base64|screenshot|image|rawpng|binary|bytes/u.test(normalizedKey) && value.length > 1_024) {
    return `<omitted ${normalizedKey.includes('screenshot') ? 'screenshot' : normalizedKey.includes('image') ? 'image' : 'binary'} payload: ${value.length} characters>`;
  }
  if (/^data:[^,]+;base64,/iu.test(value)) {
    return `<omitted base64 data URL: ${value.length} characters>`;
  }
  return undefined;
}

function normalizeDiagnosticValue(
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value === undefined) return '<undefined>';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const omitted = omittedBinary(value, key);
    if (omitted) return omitted;
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}\n…[truncated ${value.length - MAX_STRING_CHARS} characters]`;
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `<function${value.name ? ` ${value.name}` : ''}>`;

  if (typeof value !== 'object') return String(value);
  const binary = omittedBinary(value, key);
  if (binary) return binary;
  if (seen.has(value)) return '<circular reference>';
  if (depth >= MAX_NESTING_DEPTH) return '<maximum diagnostic nesting reached>';

  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '<invalid date>' : value.toISOString();
    if (value instanceof Error) {
      const error: Record<string, unknown> = {
        name: value.name,
        message: value.message,
      };
      const errorValue = value as Error & { code?: unknown; details?: unknown; cause?: unknown; stack?: unknown };
      if (errorValue.code !== undefined) error.code = errorValue.code;
      if (errorValue.details !== undefined) error.details = errorValue.details;
      if (errorValue.cause !== undefined) error.cause = errorValue.cause;
      if (errorValue.stack !== undefined) error.stack = errorValue.stack;
      return normalizeDiagnosticValue(error, key, seen, depth + 1);
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeDiagnosticValue(item, '', seen, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`<omitted ${value.length - MAX_ARRAY_ITEMS} additional array items>`);
      return items;
    }

    const record: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value).sort();
    } catch {
      return '<unreadable object>';
    }
    for (const property of keys.slice(0, MAX_OBJECT_KEYS)) {
      try {
        record[property] = normalizeDiagnosticValue(
          (value as Record<string, unknown>)[property],
          property,
          seen,
          depth + 1,
        );
      } catch {
        record[property] = '<unreadable property>';
      }
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      record['<diagnostic>'] = `<omitted ${keys.length - MAX_OBJECT_KEYS} additional object keys>`;
    }
    return record;
  } catch {
    return '<unserializable value>';
  } finally {
    seen.delete(value);
  }
}

/** Pretty-prints arbitrary diagnostic data without allowing payloads to break the UI. */
export function formatDiagnosticValue(value: unknown): string {
  try {
    const normalized = normalizeDiagnosticValue(value);
    let serialized = JSON.stringify(normalized, null, 2);
    if (serialized === undefined) serialized = '<undefined>';
    if (serialized.length > MAX_VALUE_CHARS) {
      const omitted = serialized.length - MAX_VALUE_CHARS;
      serialized = `${serialized.slice(0, MAX_VALUE_CHARS)}\n…[diagnostic value truncated; ${omitted} serialized characters omitted]`;
    }
    return serialized;
  } catch {
    return '<unable to serialize diagnostic value>';
  }
}

function boundedText(value: string): string {
  return value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS)}\n…[truncated ${value.length - MAX_STRING_CHARS} characters]`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return formatDiagnosticValue(left) === formatDiagnosticValue(right);
}

function addValue(lines: string[], label: string, value: unknown): void {
  lines.push(`${label}:`);
  lines.push(formatDiagnosticValue(value));
}

function criterionLabel(criterion: CompletionCriterion): string {
  switch (criterion.type) {
    case 'browser.url': return `Browser URL is ${criterion.url}`;
    case 'file.exists': return `File exists: ${criterion.path}`;
    case 'file.contains': return `File contains expected content: ${criterion.path}`;
    case 'window.open': return `Window open${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'window.focused': return `Window focused${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'custom': return criterion.description;
  }
}

function timestampOrder(timestamp?: string): number {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function verificationLines(verification: NonNullable<RunStep['verification']>): string[] {
  const lines = [
    `Complete: ${verification.complete}`,
    `Summary: ${boundedText(verification.summary) || '<empty>'}`,
  ];
  if (verification.criteria.length > 0) {
    lines.push('Criteria:');
    for (const check of verification.criteria) {
      lines.push(`- [${check.passed ? 'satisfied' : 'pending'}] ${boundedText(check.message || criterionLabel(check.criterion))}`);
      if (check.evidence !== undefined) lines.push(`  Evidence: ${formatDiagnosticValue(check.evidence)}`);
    }
  }
  if (verification.requirements?.length) {
    lines.push('Requirements:');
    for (const check of verification.requirements) {
      lines.push(`- [${check.passed ? 'satisfied' : 'pending'}] ${check.requirement.id}: ${boundedText(check.message || check.requirement.description)}`);
      if (check.evidence !== undefined) lines.push(`  Evidence: ${formatDiagnosticValue(check.evidence)}`);
    }
  }
  return lines;
}

function stepEntry(step: RunStep, index: number): TimelineEntry {
  const timestamp = step.createdAt || step.completedAt;
  const toolName = step.toolName ?? (step.decision?.type === 'action' ? step.decision.tool : undefined);
  const proposedTool = step.decision?.type === 'action' ? step.decision.tool : undefined;
  const lines = [`Step index: ${step.stepIndex}`, `Step ID: ${step.id}`, `Phase: ${step.phase}`];
  if (step.completedAt) lines.push(`Recorded completed at: ${step.completedAt}`);
  if (proposedTool && step.toolName && proposedTool !== step.toolName) {
    lines.push(`Proposed tool: ${proposedTool}`, `Executed tool: ${step.toolName}`);
  } else if (toolName) {
    lines.push(`Tool: ${toolName}`);
  }

  const proposed = step.decision?.type === 'action' ? step.decision.input : undefined;
  const executed = step.toolInput;
  if (proposed !== undefined && executed !== undefined) {
    if (jsonEqual(proposed, executed)) {
      addValue(lines, 'Input (proposed and executed)', proposed);
    } else {
      addValue(lines, 'Proposed input', proposed);
      addValue(lines, 'Executed input', executed);
    }
  } else if (proposed !== undefined) {
    addValue(lines, 'Proposed input', proposed);
  } else if (executed !== undefined) {
    addValue(lines, 'Executed input', executed);
  }

  if (step.decision?.type === 'action' && step.decision.reasoningSummary) {
    lines.push(`Decision summary: ${boundedText(step.decision.reasoningSummary)}`);
  } else if (step.decision?.type === 'complete') {
    lines.push('Decision: completion requested');
    if (step.decision.reasoningSummary) lines.push(`Decision summary: ${boundedText(step.decision.reasoningSummary)}`);
  } else if (step.decision?.type === 'blocked') {
    lines.push(`Decision: blocked · ${boundedText(step.decision.reason)}`);
  }
  if (step.objective) addValue(lines, 'Objective', step.objective);
  if (step.worker) lines.push(`Worker: ${step.worker}`);
  if (step.orchestratorDecision) addValue(lines, 'Orchestrator decision', step.orchestratorDecision);
  if (step.workerResult) addValue(lines, 'Worker result', step.workerResult);
  if (step.progress) addValue(lines, 'Progress state', step.progress);
  if (step.toolResult !== undefined) addValue(lines, 'Tool result', step.toolResult);
  if (step.observation !== undefined) addValue(lines, 'Observation', step.observation);
  if (step.verification) {
    lines.push('Verification:');
    lines.push(...verificationLines(step.verification));
  }

  return {
    timestamp,
    timestampOrder: timestampOrder(timestamp),
    insertionOrder: index,
    label: `Persisted RunStep · phase=${step.phase}${toolName ? ` · ${toolName}` : ''}`,
    body: lines,
  };
}

function eventEntry(event: HelmEvent, index: number): TimelineEntry {
  return {
    timestamp: event.timestamp,
    timestampOrder: timestampOrder(event.timestamp),
    insertionOrder: index,
    label: event.type,
    body: [`Event payload:\n${formatDiagnosticValue(event.payload)}`],
  };
}

function latestVerification(run: RunDetails): RunStep['verification'] {
  return [...run.steps]
    .filter((step) => step.verification)
    .sort((left, right) => timestampOrder(right.createdAt) - timestampOrder(left.createdAt) || right.stepIndex - left.stepIndex)[0]
    ?.verification;
}

function appendFinalVerification(lines: string[], run: RunDetails): void {
  const verification = latestVerification(run);
  lines.push('', 'Final verification:');
  if (verification) {
    lines.push(...verificationLines(verification));
  } else {
    lines.push('No persisted verification result is available.');
  }

  const requirements = run.state?.task.requirements ?? [];
  const completed = new Set(run.state?.completedRequirementIds ?? []);
  const verifiedRequirements = verification?.requirements;
  if (verifiedRequirements?.length) {
    lines.push('Requirement state:');
    for (const check of verifiedRequirements) {
      lines.push(`- [${check.passed ? 'satisfied' : 'pending'}] ${check.requirement.id}: ${boundedText(check.message || check.requirement.description)}`);
    }
  } else if (requirements.length > 0) {
    lines.push('Requirement state:');
    for (const requirement of requirements) {
      lines.push(`- [${completed.has(requirement.id) ? 'satisfied' : 'pending'}] ${requirement.id}: ${boundedText(requirement.description)}`);
    }
  } else {
    lines.push('No compiled requirement state is available.');
  }
}

function appendModelRequestOutcomes(lines: string[], run: RunDetails): void {
  const outcomes = run.diagnostics?.modelRequestOutcomes ?? [];
  lines.push('', 'Model request outcomes:');
  if (outcomes.length === 0) {
    lines.push('No model request outcomes were recorded.');
    return;
  }
  for (const [index, outcome] of outcomes.entries()) {
    const details = [
      `kind=${outcome.kind}`,
      `outcome=${outcome.outcome}`,
      `providerCalls=${outcome.providerCalls}`,
      `providerRetries=${outcome.providerRetries}`,
    ];
    if (outcome.finishReason) details.push(`finishReason=${outcome.finishReason}`);
    if (outcome.errorCode) details.push(`errorCode=${outcome.errorCode}`);
    if (outcome.errorName) details.push(`errorName=${outcome.errorName}`);
    if (outcome.completion) details.push(`completion=${outcome.completion}`);
    lines.push(`${index + 1}. Request ${outcome.request}: ${details.join(' · ')}`);
    for (const call of outcome.toolCalls ?? []) {
      lines.push(`   - ${call.tool}: ${call.outcome}${call.errorCode ? ` (${call.errorCode})` : ''}`);
      if (call.input !== undefined) lines.push(`     Input: ${formatDiagnosticValue(call.input)}`);
      if (call.validationIssues?.length) {
        lines.push('     Validation issues:');
        for (const issue of call.validationIssues) {
          lines.push(`     - ${issue.path.join('.') || '<input>'} · ${issue.code}: ${boundedText(issue.message)}`);
        }
      }
    }
  }
}

/** Builds a paste-ready diagnostic log from the run's structured history. */
export function formatRunActivityForClipboard(run: RunDetails, options: FormatOptions = {}): string {
  try {
    const lines = [
      'Helm Activity Log',
      `Run ID: ${boundedText(run.id)}`,
      `Thread ID: ${boundedText(run.threadId || '<unknown>')}`,
      `Source message ID: ${boundedText(run.sourceMessageId || '<unknown>')}`,
      `Status: ${run.status}`,
      `Created: ${run.createdAt || '<unknown>'}`,
      `Started: ${run.startedAt || '<not recorded>'}`,
      `Completed: ${run.completedAt || '<not recorded>'}`,
      `History source: ${options.historySource === 'server' ? 'fresh server run details' : 'currently loaded run data'}`,
      `Persisted history completeness: ${options.historySource === 'server' ? 'complete run-step list returned by the unpaginated run endpoint' : 'local snapshot; completeness is not guaranteed'}`,
      `Persisted run steps: ${run.steps.length}`,
      `Runtime events captured in this UI session: ${options.runtimeEvents?.events.length ?? 0}`,
      '',
      'User request / goal:',
      boundedText(run.goal || '<not recorded>'),
    ];

    if (options.historySource !== 'server') {
      lines.push('', '[WARNING] The complete persisted run history was not freshly fetched. The log contains only the run steps currently loaded in the UI.');
    }
    if (options.historyRefreshWarning) {
      lines.push(`[WARNING] Could not refresh run history: ${boundedText(options.historyRefreshWarning)}`);
    }
    const runtimeEvents = options.runtimeEvents?.runId === run.id ? options.runtimeEvents : undefined;
    if (!runtimeEvents?.startedObserved) {
      lines.push('[WARNING] The complete WebSocket event stream was not captured in this UI session (run.started was not observed). Runtime events are not replayed by the server; persisted run steps are included separately.');
    } else {
      lines.push('Runtime events are captured from this UI session; the server does not persist or replay the event stream.');
    }
    if (runtimeEvents?.truncated) {
      lines.push('[WARNING] The in-session event buffer reached its limit; some earlier runtime events were dropped.');
    }
    if (runtimeEvents?.connectionInterrupted) {
      lines.push('[WARNING] The WebSocket disconnected while this run was active; runtime events may be missing between reconnects. Persisted run steps remain complete.');
    }

    const events = runtimeEvents?.events ?? [];
    const timeline = [
      ...events.map((event, index) => eventEntry(event, index)),
      ...run.steps.map((step, index) => stepEntry(step, events.length + index)),
    ].sort((left, right) => left.timestampOrder - right.timestampOrder || left.insertionOrder - right.insertionOrder);

    lines.push('', `Activity timeline (${timeline.length} entries; ordered by timestamp where available):`);
    if (timeline.length === 0) lines.push('No activity entries were recorded.');
    for (const [index, entry] of timeline.entries()) {
      lines.push('', '========================================', `[${index + 1}] ${entry.timestamp || 'timestamp unavailable'}`, `Event: ${entry.label}`, ...entry.body);
    }

    lines.push('', 'Final status:', run.status);
    if (run.error) {
      lines.push('', 'Final error:', `Code: ${run.error.code}`, `Message: ${boundedText(run.error.message)}`);
      if (run.error.details !== undefined) addValue(lines, 'Error details', run.error.details);
    } else {
      lines.push('Final error: none');
    }
    appendFinalVerification(lines, run);
    appendModelRequestOutcomes(lines, run);
    lines.push('', 'Run diagnostics:');
    if (run.diagnostics) lines.push(formatDiagnosticValue(run.diagnostics));
    else lines.push('<not available>');

    const output = lines.join('\n');
    if (output.length <= MAX_LOG_CHARS) return output;
    const omitted = output.length - MAX_LOG_CHARS;
    const finalStatusOffset = output.indexOf('\nFinal status:\n');
    const warning = `\n\n[WARNING] The full diagnostic exceeded the ${MAX_LOG_CHARS.toLocaleString()} character clipboard limit; ${omitted.toLocaleString()} characters were omitted.`;
    if (finalStatusOffset >= 0) {
      const history = output.slice(0, finalStatusOffset);
      const finalDetails = output.slice(finalStatusOffset);
      const historyBudget = MAX_LOG_CHARS - finalDetails.length - warning.length;
      if (historyBudget > 0) return `${history.slice(0, historyBudget)}${warning}${finalDetails}`;
      return `${finalDetails.slice(0, MAX_LOG_CHARS - warning.length)}${warning}`;
    }
    return `${output.slice(0, MAX_LOG_CHARS - warning.length)}${warning}`;
  } catch {
    return [
      'Helm Activity Log',
      `Run ID: ${typeof run?.id === 'string' ? boundedText(run.id) : '<unavailable>'}`,
      '[WARNING] The activity log formatter encountered an unexpected value and could not format the complete run.',
    ].join('\n');
  }
}
