import { useState } from 'react';
import type { LiveActivity, RunDetails, VmAction, VmStatus } from '../types';
import { humanize } from '../format';
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
  liveActivity,
  onCancelRun,
  onRetryRun,
  isRetryingRun,
}: DesktopPanelProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const state = vm?.state ?? 'unavailable';
  const status = statusClasses(state);

  return (
    <>
      <aside
        aria-label="Controlled desktop"
        className="hidden min-h-0 w-[38%] min-w-0 shrink-0 border-l border-white/[0.06] bg-[#0d1015] lg:flex lg:flex-col xl:w-[42%]"
      >
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#f1f3f5]">Desktop</h2>
            <p className="mt-1 truncate text-xs text-[#606975]">Controlled environment</p>
          </div>
          <span className={`flex shrink-0 items-center gap-1.5 text-xs ${status.text}`}>
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            {humanize(state)}
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 space-y-4 p-5 pb-4">
            <button
              aria-label={screenshot ? 'Open desktop screenshot' : 'Desktop screenshot unavailable'}
              className="block w-full overflow-hidden rounded-lg bg-black text-left outline-none transition hover:bg-[#050607] focus-visible:ring-2 focus-visible:ring-teal-400/50 disabled:cursor-default"
              disabled={!screenshot}
              onClick={() => setViewerOpen(true)}
              type="button"
            >
              <div className="flex aspect-[16/10] items-center justify-center">
                {screenshot ? (
                  <img alt="Latest Linux guest desktop screenshot" className="h-full w-full object-contain" src={screenshot} />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-xs text-[#606975]">
                    <Icon name="monitor" size={24} />
                    <span>{state === 'unavailable' ? 'VM helper unavailable' : 'No desktop screenshot yet'}</span>
                  </div>
                )}
              </div>
            </button>

            <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-[#79838f]">
              <span className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${vm?.guestConnected ? 'bg-emerald-400' : 'bg-[#606975]'}`} />
                {vm?.guestConnected ? 'Guest connected' : 'Guest not connected'}
              </span>
              {screenshot ? <Button onClick={() => setViewerOpen(true)} size="sm" variant="ghost">Open viewer</Button> : null}
            </div>

            {vm?.message ? <p className="text-xs leading-5 text-[#79838f]">{vm.message}</p> : null}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={vmAction !== null || state === 'running' || state === 'starting'}
                onClick={() => void onVmAction('start')}
                size="sm"
                variant="secondary"
              >
                <Icon name="play" size={13} />
                Start
              </Button>
              <Button
                disabled={vmAction !== null || state === 'stopped' || state === 'stopping' || state === 'unavailable'}
                onClick={() => void onVmAction('stop')}
                size="sm"
                variant="secondary"
              >
                <Icon name="square" size={12} />
                Stop
              </Button>
              <Button disabled={vmAction !== null} onClick={() => void onVmAction('reset')} size="sm" variant="ghost">
                <Icon name="refresh" size={13} />
                Restart
              </Button>
            </div>
          </div>

          <section aria-label="Agent activity" className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06]">
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-2">
                <Icon className="text-[#79838f]" name="activity" size={14} />
                <h3 className="text-xs font-medium text-[#d7dde3]">Activity</h3>
              </div>
              {run ? <span className="text-[10px] text-[#606975]">Live</span> : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 pb-5">
                <RunActivityFeed
                  isRetryingRun={isRetryingRun}
                  liveActivity={liveActivity}
                  onCancelRun={onCancelRun}
                  onRetryRun={onRetryRun}
                  run={run}
                />
              </div>
            </ScrollArea>
          </section>
        </div>
      </aside>

      <DesktopViewer onOpenChange={setViewerOpen} open={viewerOpen} screenshot={screenshot} vm={vm} />
    </>
  );
}
