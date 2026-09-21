import { memo, useState } from 'react';
import type { CompletionCriterion } from '@helm/shared';
import type { RunDetails, RunStep, VmAction, VmStatus } from '../types';
import { humanize } from '../format';
import { Icon } from './Icon';
import { DesktopViewer } from './DesktopViewer';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

type ActivityDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: RunDetails | null;
  vm: VmStatus | null;
  screenshot: string | null;
  vmAction: VmAction | null;
  onVmAction: (action: VmAction) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  onRunDemo: () => Promise<void>;
  isRunStarting: boolean;
};

function displayValue(value: unknown, empty = 'No data recorded') {
  if (value === undefined || value === null || value === '') {
    return empty;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? empty;
  } catch {
    return 'Unable to display this value';
  }
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

function statusClasses(status: string) {
  if (['completed', 'connected', 'ok'].includes(status)) {
    return { text: 'text-emerald-300', dot: 'bg-emerald-400' };
  }
  if (['running', 'pending', 'starting', 'reconnecting'].includes(status)) {
    return { text: 'text-teal-300', dot: 'bg-teal-300' };
  }
  if (['failed', 'blocked', 'cancelled', 'error', 'unavailable'].includes(status)) {
    return { text: 'text-red-300', dot: 'bg-red-400' };
  }
  return { text: 'text-[#79838f]', dot: 'bg-[#606975]' };
}

function actionText(step: RunStep) {
  if (step.decision?.type === 'action') {
    return `${step.decision.tool}\n${displayValue(step.decision.input)}`;
  }
  if (step.toolName) {
    return `${step.toolName}\n${displayValue(step.toolInput)}`;
  }
  if (step.decision?.type === 'complete') {
    return 'completion requested';
  }
  if (step.decision?.type === 'blocked') {
    return `blocked\n${step.decision.reason}`;
  }
  return 'No action recorded';
}

function stepTitle(step: RunStep) {
  if (step.toolName) {
    return humanize(step.toolName);
  }
  if (step.decision?.type === 'action') {
    return humanize(step.decision.tool);
  }
  if (step.decision?.type === 'complete') {
    return 'Complete task';
  }
  if (step.decision?.type === 'blocked') {
    return 'Run blocked';
  }
  return humanize(step.phase);
}

function StepMark({ active, failed }: { active: boolean; failed: boolean }) {
  if (failed) {
    return <span className="flex size-5 items-center justify-center rounded-full bg-red-400/10 text-red-300"><Icon name="x" size={12} /></span>;
  }
  if (active) {
    return <span className="flex size-5 items-center justify-center rounded-full bg-teal-400/10 text-teal-300"><span className="size-1.5 animate-pulse rounded-full bg-teal-300" /></span>;
  }
  return <span className="flex size-5 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300"><Icon name="check" size={12} /></span>;
}

const TraceStep = memo(function TraceStep({ step, active }: { step: RunStep; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const failed = step.phase === 'failed' || step.phase === 'blocked';
  const verification = step.verification;
  return (
    <Collapsible className="border-b border-white/[0.06] last:border-b-0" onOpenChange={setExpanded} open={expanded}>
      <CollapsibleTrigger className="flex w-full items-center gap-3 py-3 text-left outline-none transition-colors hover:text-[#f1f3f5] focus-visible:ring-2 focus-visible:ring-teal-400/50">
        <StepMark active={active} failed={failed} />
        <span className="min-w-0 flex-1 truncate text-sm text-[#d7dde3]">{stepTitle(step)}</span>
        <span className="text-[11px] text-[#606975]">{expanded ? 'Hide' : 'Details'}</span>
        <Icon className={`shrink-0 text-[#606975] transition-transform ${expanded ? 'rotate-180' : ''}`} name="chevron-down" size={14} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3 pl-8">
        <div className="space-y-3 text-xs">
          <DetailBlock label="Reason" value={step.decision?.reasoningSummary ?? 'Operational decision recorded by the provider.'} />
          <DetailBlock label="Action" value={actionText(step)} pre />
          <DetailBlock label="Observation" value={displayValue(step.observation ?? step.toolResult)} pre />
          <div>
            <p className="mb-1 text-[11px] font-medium text-[#606975]">Verification</p>
            {verification ? (
              <div className="space-y-1.5">
                {verification.criteria.map((criterion, index) => (
                  <div className="flex items-start gap-2 text-[#aeb7c1]" key={`${criterionLabel(criterion.criterion)}-${index}`}>
                    <Icon className={criterion.passed ? 'mt-0.5 shrink-0 text-emerald-300' : 'mt-0.5 shrink-0 text-red-300'} name={criterion.passed ? 'check' : 'x'} size={13} />
                    <span>{criterion.message || criterionLabel(criterion.criterion)}</span>
                  </div>
                ))}
                <p className="pt-1 text-[#79838f]">{verification.summary}</p>
              </div>
            ) : (
              <p className="text-[#79838f]">No verification recorded for this step.</p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

function DetailBlock({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-[#606975]">{label}</p>
      {pre ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 p-2 font-mono text-[11px] leading-5 text-[#aeb7c1]">{value}</pre>
      ) : (
        <p className="whitespace-pre-wrap break-words leading-5 text-[#aeb7c1]">{value}</p>
      )}
    </div>
  );
}

function VerificationList({ run }: { run: RunDetails }) {
  const latestVerification = [...run.steps].sort((a, b) => b.stepIndex - a.stepIndex).find((step) => step.verification)?.verification;
  const criteria = latestVerification?.criteria ?? run.criteria.map((criterion) => ({ criterion, passed: false, message: 'Waiting for verification.' }));
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#d7dde3]">Verification</h3>
        {latestVerification?.complete ? <span className="text-xs text-emerald-300">Complete</span> : null}
      </div>
      <div className="space-y-2">
        {criteria.map((criterion, index) => (
          <div className="flex items-start gap-2.5 text-sm" key={`${criterionLabel(criterion.criterion)}-${index}`}>
            <Icon className={`mt-0.5 shrink-0 ${criterion.passed ? 'text-emerald-300' : 'text-[#606975]'}`} name={criterion.passed ? 'check' : 'circle'} size={14} />
            <div className="min-w-0">
              <p className={criterion.passed ? 'text-[#c9d1d9]' : 'text-[#929aa5]'}>{criterion.message || criterionLabel(criterion.criterion)}</p>
              {!criterion.passed && criterion.message ? <p className="mt-0.5 text-xs text-[#606975]">{criterionLabel(criterion.criterion)}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunProgress({ run, onCancelRun }: { run: RunDetails; onCancelRun: (runId: string) => Promise<void> }) {
  const steps = [...run.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const activeStepId = run.status === 'running' || run.status === 'pending' ? steps.at(-1)?.id : undefined;
  const status = statusClasses(run.status);
  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${status.dot}`} />
              <span className={`text-xs font-medium ${status.text}`}>{humanize(run.status)}</span>
            </div>
            <p className="mt-2 text-sm leading-5 text-[#c9d1d9]">{run.goal || 'Scripted runtime task'}</p>
          </div>
          {run.status === 'running' || run.status === 'pending' ? (
            <Button onClick={() => void onCancelRun(run.id)} size="sm" variant="destructive">
              <Icon name="square" size={12} />
              Stop
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-[#606975]">{steps.length} {steps.length === 1 ? 'step' : 'steps'} recorded</p>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-[#d7dde3]">Steps</h3>
        <div>
          {steps.length > 0 ? steps.map((step) => <TraceStep active={step.id === activeStepId} key={step.id} step={step} />) : (
            <div className="flex items-center gap-2 py-4 text-sm text-[#79838f]"><span className="size-1.5 animate-pulse rounded-full bg-teal-300" /> Waiting for the first action…</div>
          )}
        </div>
      </section>

      <VerificationList run={run} />
      {run.error ? <div className="rounded-md border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 text-sm leading-5 text-red-200">{run.error.message}</div> : null}
    </div>
  );
}

function DesktopSection({
  screenshot,
  vm,
  onOpen,
}: {
  screenshot: string | null;
  vm: VmStatus | null;
  onOpen: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#d7dde3]">Desktop</h3>
        {screenshot ? <Button onClick={onOpen} size="sm" variant="ghost">Open desktop</Button> : null}
      </div>
      <button
        aria-label={screenshot ? 'Open desktop screenshot' : 'Desktop screenshot unavailable'}
        className="block w-full overflow-hidden rounded-lg border border-white/[0.08] bg-black text-left outline-none transition hover:border-white/[0.16] focus-visible:ring-2 focus-visible:ring-teal-400/50"
        disabled={!screenshot}
        onClick={onOpen}
        type="button"
      >
        {screenshot ? (
          <img alt="Latest Linux guest desktop screenshot" className="aspect-video w-full object-cover" src={screenshot} />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center gap-2 text-xs text-[#606975]"><Icon name="monitor" size={21} /><span>{vm?.state === 'unavailable' ? 'VM helper unavailable' : 'No desktop screenshot yet'}</span></div>
        )}
      </button>
      <div className="flex items-center gap-2 text-xs text-[#79838f]">
        <span className={`size-1.5 rounded-full ${vm?.guestConnected ? 'bg-emerald-400' : 'bg-[#606975]'}`} />
        <span>{vm?.guestConnected ? 'Connected' : 'Not connected'}</span>
      </div>
    </section>
  );
}

function EnvironmentSection({ vm, vmAction, onVmAction }: Pick<ActivityDrawerProps, 'vm' | 'vmAction' | 'onVmAction'>) {
  const state = vm?.state ?? 'unavailable';
  const status = statusClasses(state);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#d7dde3]">Environment</h3>
        <span className={`flex items-center gap-1.5 text-xs ${status.text}`}><span className={`size-1.5 rounded-full ${status.dot}`} />{humanize(state)}</span>
      </div>
      {vm?.message ? <p className="text-xs leading-5 text-[#79838f]">{vm.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={vmAction !== null || state === 'running' || state === 'starting'} onClick={() => void onVmAction('start')} size="sm" variant="secondary"><Icon name="play" size={13} />Start</Button>
        <Button disabled={vmAction !== null || state === 'stopped' || state === 'stopping' || state === 'unavailable'} onClick={() => void onVmAction('stop')} size="sm" variant="secondary"><Icon name="square" size={12} />Stop</Button>
        <Button disabled={vmAction !== null} onClick={() => void onVmAction('reset')} size="sm" variant="ghost"><Icon name="refresh" size={13} />Restart</Button>
      </div>
    </section>
  );
}

export function ActivityDrawer({
  open,
  onOpenChange,
  run,
  vm,
  screenshot,
  vmAction,
  onVmAction,
  onCancelRun,
  onRunDemo,
  isRunStarting,
}: ActivityDrawerProps) {
  const [desktopOpen, setDesktopOpen] = useState(false);
  return (
    <>
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent className="w-[min(100vw,400px)] p-0 sm:max-w-[400px]" side="right">
          <SheetHeader className="border-b border-white/[0.06] pr-14">
            <SheetTitle>Activity</SheetTitle>
            <SheetDescription>Agent actions, verification, and the controlled desktop.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-8 px-5 pb-8 pt-5">
              {run ? (
                <>
                  <RunProgress onCancelRun={onCancelRun} run={run} />
                  <DesktopSection onOpen={() => setDesktopOpen(true)} screenshot={screenshot} vm={vm} />
                  <EnvironmentSection onVmAction={onVmAction} vm={vm} vmAction={vmAction} />
                </>
              ) : (
                <section className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-[#d7dde3]">No active run</h3>
                    <p className="mt-2 text-sm leading-6 text-[#79838f]">Start a task to see actions, observations, and verification.</p>
                  </div>
                  <Button disabled={isRunStarting} onClick={() => void onRunDemo()} size="sm" variant="secondary">
                    <Icon name="play" size={14} />
                    {isRunStarting ? 'Starting…' : 'Run scripted demo'}
                  </Button>
                </section>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <DesktopViewer onOpenChange={setDesktopOpen} open={desktopOpen} screenshot={screenshot} vm={vm} />
    </>
  );
}
