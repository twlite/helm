import { useState } from 'react';
import { helmApi } from '../api';
import type { LiveActivity, RunActivityEventHistory, RunDetails, VmAction, VmStatus } from '../types';
import { humanize } from '../format';
import { formatRunActivityForClipboard } from '../run-activity-clipboard';
import { Icon } from './Icon';
import { DesktopViewer } from './DesktopViewer';
import { RunActivityFeed } from './RunActivityFeed';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';

type DesktopPanelProps = {
  screenshot: string | null;
  vm: VmStatus | null;
  vmAction: VmAction | null;
  onVmAction: (action: VmAction) => Promise<void>;
  run: RunDetails | null;
  getActivityEventHistory: (runId: string) => RunActivityEventHistory | undefined;
  liveActivity?: LiveActivity;
  onCancelRun: (runId: string) => Promise<void>;
  onRetryRun: (runId?: string) => Promise<void>;
  isRetryingRun: boolean;
};

function statusClasses(status: string) {
  if (['running', 'connected', 'ok'].includes(status)) {
    return { text: 'text-emerald-300', dot: 'bg-emerald-400' };
  }
  if (['starting', 'stopping', 'reconnecting'].includes(status)) {
    return { text: 'text-teal-300', dot: 'bg-teal-300' };
  }
  if (['error', 'unavailable'].includes(status)) {
    return { text: 'text-red-300', dot: 'bg-red-400' };
  }
  return { text: 'text-[#79838f]', dot: 'bg-[#606975]' };
}

export function DesktopPanel({
  screenshot,
  vm,
  vmAction,
  onVmAction,
  run,
  getActivityEventHistory,
  liveActivity,
  onCancelRun,
  onRetryRun,
  isRetryingRun,
}: DesktopPanelProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'warning' | 'failed'>('idle');
  const [copyRunId, setCopyRunId] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const visibleCopyStatus = copyRunId === run?.id ? copyStatus : 'idle';
  const visibleCopyError = copyRunId === run?.id ? copyError : undefined;
  const state = vm?.state ?? 'unavailable';
  const status = statusClasses(state);

  async function copyActivityLog() {
    if (!run || copyStatus === 'copying') return;
    setCopyRunId(run.id);
    setCopyStatus('copying');
    setCopyError(undefined);

    let activityRun = run;
    let historySource: 'server' | 'local' = 'server';
    let historyRefreshWarning: string | undefined;
    try {
      activityRun = await helmApi.getRun(run.id);
    } catch (error) {
      historySource = 'local';
      historyRefreshWarning = error instanceof Error ? error.message : String(error);
    }

    const matchingEventHistory = getActivityEventHistory(activityRun.id);
    const text = formatRunActivityForClipboard(activityRun, {
      historySource,
      historyRefreshWarning,
      runtimeEvents: matchingEventHistory,
    });

    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable in this browser context.');
      }
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyError(message);
      setCopyStatus('failed');
      return;
    }

    setCopyStatus(historySource === 'local'
      || !matchingEventHistory?.startedObserved
      || matchingEventHistory.truncated
      || matchingEventHistory.connectionInterrupted
      ? 'warning'
      : 'copied');
  }

  return (
    <>
      <aside
        aria-label="Controlled desktop"
        className="hidden min-h-0 w-[clamp(390px,34vw,600px)] min-w-[390px] shrink-0 border-l border-[var(--border)] bg-[var(--pane-bg)] lg:flex lg:flex-col"
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-3">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-[var(--text)]">Desktop</h2>
          </div>
          <span
            className={`flex shrink-0 items-center gap-1.5 text-xs ${status.text}`}
          >
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            {humanize(state)}
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--border)] p-3">
            <button
              aria-label={
                screenshot
                  ? 'Open desktop screenshot'
                  : 'Desktop screenshot unavailable'
              }
              className="block w-full overflow-hidden border border-[var(--border)] bg-black text-left outline-none transition-colors hover:border-[var(--border-strong)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:cursor-default"
              disabled={!screenshot}
              onClick={() => setViewerOpen(true)}
              type="button"
            >
              <div className="flex aspect-[16/10] items-center justify-center">
                {screenshot ? (
                  <img
                    alt="Latest Linux guest desktop screenshot"
                    className="h-full w-full object-contain"
                    src={screenshot}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-xs text-[#606975]">
                    <Icon name="monitor" size={24} />
                    <span>
                      {state === 'unavailable'
                        ? 'VM helper unavailable'
                        : 'No desktop screenshot yet'}
                    </span>
                  </div>
                )}
              </div>
            </button>

            <div className="mt-2 flex min-w-0 items-center justify-between gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-2">
                <span
                  className={`size-1.5 rounded-full ${vm?.guestConnected ? 'bg-emerald-400' : 'bg-[#606975]'}`}
                />
                {vm?.guestConnected ? 'Guest connected' : 'Guest not connected'}
              </span>
              {screenshot ? (
                <Button
                  onClick={() => setViewerOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  Expand
                </Button>
              ) : null}
            </div>

            {vm?.message ? <p className="mt-1 break-words text-[10px] text-[var(--text-muted)]">{vm.message}</p> : null}

            <div className="mt-2 flex flex-wrap gap-1">
              <Button
                disabled={
                  vmAction !== null ||
                  state === 'running' ||
                  state === 'starting'
                }
                onClick={() => void onVmAction('start')}
                size="sm"
                variant="secondary"
              >
                <Icon name="play" size={13} />
                Start
              </Button>
              <Button
                disabled={vmAction !== null || vm?.guestConnected === true}
                onClick={() => void onVmAction('reconnect')}
                size="sm"
                variant="ghost"
              >
                <Icon name="refresh" size={13} />
                Reconnect
              </Button>
            </div>
          </div>

          <section
            aria-label="Agent activity"
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-3">
              <div className="flex items-center gap-2">
                <Icon className="text-[#79838f]" name="activity" size={14} />
                <h3 className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Activity</h3>
              </div>
              {run ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-[#606975]">Live</span>
                  <Button
                    aria-label="Copy activity log"
                    className="h-6 gap-1 px-1.5 text-[10px]"
                    disabled={copyStatus === 'copying'}
                    onClick={() => void copyActivityLog()}
                    size="sm"
                    title={visibleCopyError ?? (visibleCopyStatus === 'warning' ? 'Copied with a history warning; see the warning in the copied log.' : undefined)}
                    variant="ghost"
                  >
                    <Icon name={visibleCopyStatus === 'copied' ? 'check' : visibleCopyStatus === 'failed' ? 'x' : 'copy'} size={12} />
                    {visibleCopyStatus === 'copying' ? 'Copying…'
                      : visibleCopyStatus === 'copied' ? 'Copied'
                        : visibleCopyStatus === 'warning' ? 'Copied · warning'
                          : visibleCopyStatus === 'failed' ? 'Copy failed' : 'Copy log'}
                  </Button>
                </div>
              ) : null}
              <span aria-live="polite" className="sr-only" role={visibleCopyStatus === 'failed' ? 'alert' : 'status'}>
                {visibleCopyStatus === 'failed' ? `Failed to copy activity log. ${visibleCopyError ?? ''}`
                  : visibleCopyStatus === 'copied' ? 'Copied activity log.'
                    : visibleCopyStatus === 'warning' ? 'Copied activity log with a history warning.' : ''}
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-3 pb-4 pt-1">
                <RunActivityFeed
                  isRetryingRun={isRetryingRun}
                  liveActivity={liveActivity}
                  onCancelRun={onCancelRun}
                  onRetryRun={onRetryRun}
                  run={run}
                  compact
                />
              </div>
            </ScrollArea>
          </section>
        </div>
      </aside>

      <DesktopViewer
        onOpenChange={setViewerOpen}
        open={viewerOpen}
        screenshot={screenshot}
        vm={vm}
      />
    </>
  );
}
