import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MoonIcon, RefreshCwIcon, SunIcon } from 'lucide-react';
import { formatStatus } from './utils';
import type { ThemeMode } from './use-theme-mode';

interface DashboardHeaderProps {
  activeTitle: string;
  conversationStatus: string | null;
  onRefresh: () => void;
  onToggleThemeMode: () => void;
  themeMode: ThemeMode;
}

export function DashboardHeader({
  activeTitle,
  conversationStatus,
  onRefresh,
  onToggleThemeMode,
  themeMode,
}: DashboardHeaderProps) {
  return (
    <header className="flex items-center justify-between rounded-2xl border border-border/70 bg-card/70 px-4 py-3 backdrop-blur">
      <div className="min-w-0">
        <h1 className="truncate font-heading text-xl">{activeTitle}</h1>
        <p className="text-muted-foreground text-sm">
          Agent-driven desktop automation with live tool and reasoning stream
        </p>
      </div>
      <div className="flex items-center gap-2">
        {conversationStatus ? (
          <Badge variant="outline">{formatStatus(conversationStatus)}</Badge>
        ) : null}
        <Button onClick={onToggleThemeMode} size="sm" variant="outline">
          {themeMode === 'dark' ? (
            <SunIcon className="size-4" />
          ) : (
            <MoonIcon className="size-4" />
          )}
          {themeMode === 'dark' ? 'Light' : 'Dark'}
        </Button>
        <Button onClick={onRefresh} size="sm" variant="outline">
          <RefreshCwIcon className="size-4" />
          Refresh
        </Button>
      </div>
    </header>
  );
}
