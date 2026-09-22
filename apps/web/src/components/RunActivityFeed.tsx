import { useState } from 'react';
import type { CompletionCriterion } from '@helm/shared';
import type { LiveActivity, RunDetails, RunStep } from '../types';
import { humanize } from '../format';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

type RunActivityFeedProps = {
  run: RunDetails | null;
  liveActivity?: LiveActivity;
  compact?: boolean;
  onCancelRun?: (runId: string) => Promise<void>;
  onRetryRun?: (runId?: string) => Promise<void>;
  isRetryingRun?: boolean;
  showError?: boolean;
};

type ActivityRow = {
  id: string;
  stepIndex: number;
  title: string;
  toolName?: string;
  step: RunStep;
  status: 'active' | 'complete' | 'failed';
};

function displayValue(value: unknown, empty = 'No data recorded'): string {
  if (value === undefined || value === null || value === '') return empty;
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value, null, 2) ?? empty;
    return serialized.length <= 6_000 ? serialized : `${serialized.slice(0, 5_900)}\n…[truncated]`;
  } catch {
    return 'Unable to display this value';
  }
}

function toolTitle(toolName: string): string {
  const titles: Record<string, string> = {
    'browser.navigate': 'Opened webpage',
    'browser.extractText': 'Read page contents',
    'browser.snapshot': 'Inspected webpage',
    'browser.click': 'Clicked webpage element',
    'browser.type': 'Entered text in browser',
    'fs.read': 'Read file',
    'fs.write': 'Wrote file',
    'fs.exists': 'Checked file',
    'fs.list': 'Listed files',
    'fs.stat': 'Checked file details',
    'app.launch': 'Opened application',
    'app.openFile': 'Opened file',
    'desktop.screenshot': 'Captured desktop',
    'desktop.getState': 'Checked desktop',
    'desktop.click': 'Clicked desktop',
    'desktop.type': 'Typed on desktop',
    'desktop.hotkey': 'Used keyboard shortcut',
  };
  return titles[toolName] ?? humanize(toolName);
}

function criterionLabel(criterion: CompletionCriterion): string {
  switch (criterion.type) {
    case 'browser.url':
      return `Browser URL is ${criterion.url}`;
    case 'file.exists':
      return `File exists: ${criterion.path}`;
    case 'file.contains':
      return `File contains expected content: ${criterion.path}`;
    case 'window.open':
      return `Window open${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'window.focused':
      return `Window focused${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'custom':
      return criterion.description;
  }
}

function phaseLabel(activity: LiveActivity | undefined, run: RunDetails): string {
  if (!activity || activity.runId !== run.id) {
    if (run.status === 'pending') return 'Starting Helm…';
    if (run.status === 'running') return 'Working through the task…';
    if (run.status === 'completed') return 'Task completed';
    if (run.status === 'cancelled') return 'Task stopped';
    if (run.status === 'blocked') return 'Task blocked';
    return 'Task failed';
  }
  switch (activity.phase) {
    case 'starting':
      return 'Starting Helm…';
    case 'thinking':
      return activity.toolName ? `Planning: ${toolTitle(activity.toolName)}` : 'Thinking through the next action…';
    case 'verifying':
      return 'Checking the result…';
    case 'recorded':
      return activity.toolName ? `${toolTitle(activity.toolName)} finished` : 'Action recorded';
    case 'completed':
      return 'Task completed';
    case 'cancelled':
      return 'Task stopped';
    case 'failed':
      return 'Task failed';
  }
}

function statusClasses(status: RunDetails['status']) {
  if (status === 'completed') return { text: 'text-emerald-300', dot: 'bg-emerald-400' };
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') return { text: 'text-red-300', dot: 'bg-red-400' };
  return { text: 'text-teal-300', dot: 'bg-teal-300' };
}

function stepForGroup(steps: RunStep[]): RunStep {
  return steps.find((step) => step.phase === 'act')
    ?? steps.find((step) => step.phase === 'complete' || step.phase === 'blocked' || step.phase === 'failed')
    ?? steps.find((step) => step.phase === 'reason')
    ?? steps[steps.length - 1];
}

function activityRows(run: RunDetails, liveActivity?: LiveActivity): ActivityRow[] {
  const groups = new Map<number, RunStep[]>();
  for (const step of [...run.steps].sort((left, right) => left.stepIndex - right.stepIndex)) {
    const group = groups.get(step.stepIndex) ?? [];
    group.push(step);
    groups.set(step.stepIndex, group);
  }

  return [...groups.entries()].map(([stepIndex, steps]) => {
    const step = stepForGroup(steps);
    const toolName = step.toolName ?? (step.decision?.type === 'action' ? step.decision.tool : undefined);
    const failed = step.phase === 'failed' || step.phase === 'blocked' || step.toolResult?.ok === false;
    const active = run.status === 'running'
      && liveActivity?.runId === run.id
      && liveActivity.stepIndex === stepIndex
      && liveActivity.phase !== 'recorded';
    return {
      id: step.id,
      stepIndex,
      title: toolName ? toolTitle(toolName) : step.decision?.type === 'complete' ? 'Complete task' : humanize(step.phase),
      ...(toolName ? { toolName } : {}),
      step,
      status: failed ? 'failed' : active ? 'active' : 'complete',
    };
  });
}

function StepMark({ status }: { status: ActivityRow['status'] }) {
  if (status === 'failed') {
    return <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-400/10 text-red-300"><Icon name="x" size={12} /></span>;
  }
  if (status === 'active') {
    return <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-teal-400/10 text-teal-300"><span className="size-1.5 animate-pulse rounded-full bg-teal-300" /></span>;
  }
  return <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300"><Icon name="check" size={12} /></span>;
}

function ActivityRowView({ row }: { row: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const verification = row.step.verification;
  const reasoning = row.step.decision?.reasoningSummary;
  return (
    <Collapsible className="border-b border-white/[0.06] last:border-b-0" onOpenChange={setExpanded} open={expanded}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2.5 py-2.5 text-left outline-none transition-colors hover:text-[#f1f3f5] focus-visible:ring-2 focus-visible:ring-teal-400/50">
        <StepMark status={row.status} />
        <span className="min-w-0 flex-1 truncate text-xs text-[#d7dde3]">{row.title}</span>
        <span className="shrink-0 text-[10px] text-[#606975]">{expanded ? 'Hide' : 'Details'}</span>
        <Icon className={`shrink-0 text-[#606975] transition-transform ${expanded ? 'rotate-180' : ''}`} name="chevron-down" size={13} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3 pl-7">
        <div className="space-y-2.5 text-[11px] leading-5 text-[#aeb7c1]">
          {reasoning ? <Detail label="What Helm is doing" value={reasoning} /> : null}
          {row.toolName ? <Detail label="Tool" value={row.toolName} /> : null}
          {row.step.toolInput ? <Detail label="Input" value={displayValue(row.step.toolInput)} pre /> : null}
          {row.step.toolResult ? <Detail label="Result" value={displayValue(row.step.toolResult)} pre /> : null}
          {verification ? (
            <Detail label="Verification" value={verification.summary || (verification.complete ? 'Verified.' : 'Still working.')} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Detail({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="mb-0.5 text-[10px] font-medium text-[#606975]">{label}</p>
      {pre ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-[10px] leading-4 text-[#aeb7c1]">{value}</pre> : <p className="whitespace-pre-wrap break-words">{value}</p>}
    </div>
  );
}

export function RunActivityFeed({
  run,
  liveActivity,
  compact = false,
  onCancelRun,
  onRetryRun,
  isRetryingRun = false,
  showError = true,
}: RunActivityFeedProps) {
  if (!run) {
    return <p className="text-xs leading-5 text-[#606975]">Start a task to see Helm’s actions, observations, and verification here.</p>;
  }

  const rows = activityRows(run, liveActivity);
  const status = statusClasses(run.status);
  const liveForRun = liveActivity?.runId === run.id ? liveActivity : undefined;
  const latestVerification = [...run.steps]
    .sort((left, right) => right.stepIndex - left.stepIndex)
    .find((step) => step.verification)?.verification;
  const criteria = latestVerification?.criteria
    ?? run.criteria.map((criterion) => ({ criterion, passed: false, message: 'Waiting for verification.' }));

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${status.dot} ${run.status === 'running' ? 'animate-pulse' : ''}`} />
            <span className={`text-xs font-medium ${status.text}`}>{phaseLabel(liveForRun, run)}</span>
          </div>
          {!compact ? <p className="mt-1 truncate text-[11px] text-[#606975]">{run.goal}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-[10px] text-[#606975]">{rows.length} {rows.length === 1 ? 'step' : 'steps'}</span>
          {run.status === 'running' && onCancelRun ? (
            <Button onClick={() => void onCancelRun(run.id)} size="sm" variant="ghost">
              <Icon name="square" size={11} />
              Stop
            </Button>
          ) : null}
        </div>
      </div>

      {liveForRun?.reasoningSummary ? <p className="text-xs leading-5 text-[#929aa5]">{liveForRun.reasoningSummary}</p> : null}

      {rows.length > 0 ? (
        <div>
          {rows.map((row) => <ActivityRowView key={row.id} row={row} />)}
        </div>
      ) : (
        <div className="flex items-center gap-2 py-2 text-xs text-[#79838f]"><span className="size-1.5 animate-pulse rounded-full bg-teal-300" /> Waiting for the first action…</div>
      )}

      {criteria.length > 0 ? (
        <section className="space-y-2 border-t border-white/[0.06] pt-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-[11px] font-medium text-[#aeb7c1]">Verification</h4>
            {latestVerification?.complete ? <span className="text-[10px] text-emerald-300">Complete</span> : null}
          </div>
          <div className="space-y-1.5">
            {criteria.map((criterion, index) => (
              <div className="flex min-w-0 items-start gap-2 text-[11px]" key={`${criterionLabel(criterion.criterion)}-${index}`}>
                <Icon className={`mt-0.5 shrink-0 ${criterion.passed ? 'text-emerald-300' : 'text-[#606975]'}`} name={criterion.passed ? 'check' : 'circle'} size={12} />
                <span className={`min-w-0 break-words ${criterion.passed ? 'text-[#c9d1d9]' : 'text-[#79838f]'}`}>{criterion.message || criterionLabel(criterion.criterion)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {showError && run.error ? (
        <div className="flex min-w-0 items-start gap-2 rounded-md bg-red-400/[0.07] px-2.5 py-2 text-xs text-red-200">
          <Icon className="mt-0.5 shrink-0 text-red-300" name="triangle" size={13} />
          <div className="min-w-0 flex-1">
            <p className="break-words leading-5">{run.error.message}</p>
            {run.error.code ? <p className="mt-0.5 break-all font-mono text-[10px] text-red-200/60">{run.error.code}</p> : null}
          </div>
          {onRetryRun ? <Button disabled={isRetryingRun} onClick={() => void onRetryRun(run.id)} size="sm" variant="destructive">{isRetryingRun ? 'Retrying…' : 'Retry'}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
