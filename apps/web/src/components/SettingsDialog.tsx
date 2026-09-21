import { useState } from 'react';
import type { HealthStatus } from '../types';
import { humanize } from '../format';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  health: HealthStatus | null;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  reconnectAttempt: number;
  onRefreshDiagnostics: () => Promise<void>;
};

const diagnosticRows: Array<{ key: keyof HealthStatus; label: string }> = [
  { key: 'database', label: 'SQLite' },
  { key: 'fts5', label: 'FTS5' },
  { key: 'sqliteVec', label: 'sqlite-vec' },
  { key: 'vmHelper', label: 'VM helper' },
  { key: 'browser', label: 'Browser' },
  { key: 'desktop', label: 'Desktop' },
];

function Row({ label, ready, detail }: { label: string; ready: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className={`size-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-[#606975]'}`} />
      <span className="flex-1 text-sm text-[#c9d1d9]">{label}</span>
      <span className={`text-xs ${ready ? 'text-emerald-300' : 'text-[#79838f]'}`}>{detail ?? (ready ? 'Ready' : 'Unavailable')}</span>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  health,
  connectionState,
  reconnectAttempt,
  onRefreshDiagnostics,
}: SettingsDialogProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const connectionReady = connectionState === 'connected';

  async function refresh() {
    setIsRefreshing(true);
    try {
      await onRefreshDiagnostics();
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(100vw,400px)] p-0 sm:max-w-[400px]" side="right">
        <SheetHeader className="border-b border-white/[0.06] pr-14">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle>Settings</SheetTitle>
              <SheetDescription>Helm environment and developer diagnostics.</SheetDescription>
            </div>
            <Button aria-label="Refresh diagnostics" className="-mr-2" disabled={isRefreshing} onClick={() => void refresh()} size="icon-sm" variant="ghost">
              <Icon className={isRefreshing ? 'animate-spin' : undefined} name="refresh" size={15} />
            </Button>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-8 px-5 pb-8 pt-5">
            <section>
              <h3 className="mb-1 text-sm font-medium text-[#d7dde3]">Application</h3>
              <div className="divide-y divide-white/[0.06]">
                <Row detail={connectionReady ? 'Connected' : connectionState === 'reconnecting' ? `Retry ${reconnectAttempt}` : humanize(connectionState)} label="Backend" ready={connectionReady} />
                {diagnosticRows.slice(0, 3).map((row) => <Row key={row.key} label={row.label} ready={health?.[row.key] === true} />)}
              </div>
            </section>
            <section>
              <h3 className="mb-1 text-sm font-medium text-[#d7dde3]">Environment</h3>
              <div className="divide-y divide-white/[0.06]">
                {diagnosticRows.slice(3).map((row) => <Row key={row.key} label={row.label} ready={health?.[row.key] === true} />)}
                <Row detail={health?.vm?.state ? humanize(health.vm.state) : undefined} label="Guest" ready={health?.vm?.guestConnected === true} />
                <Row detail={health?.vm?.state ? humanize(health.vm.state) : undefined} label="VM state" ready={health?.vm?.state === 'running'} />
              </div>
            </section>
            <section className="rounded-lg bg-white/[0.035] px-3 py-3 text-xs leading-5 text-[#79838f]">
              Diagnostics are read-only. VM actions and agent steps live in Activity when you open it.
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
