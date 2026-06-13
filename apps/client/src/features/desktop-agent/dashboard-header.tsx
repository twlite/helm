import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getServerInfo, type ServerInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DatabaseIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { AgentStatus } from "./types";
import type { ThemeMode } from "./use-theme-mode";

const INSTRUCTIONS_KEY = "helm_custom_instructions";

const STATUS_META: Record<AgentStatus, { label: string; pulse: boolean; colorClass: string }> = {
  idle:          { label: "Idle",               pulse: false, colorClass: "text-muted-foreground" },
  starting:      { label: "Starting…",     pulse: true,  colorClass: "text-blue-500" },
  thinking:      { label: "Thinking…",     pulse: true,  colorClass: "text-amber-500" },
  working:       { label: "Working…",      pulse: true,  colorClass: "text-blue-500" },
  responding:    { label: "Responding…",   pulse: true,  colorClass: "text-emerald-500" },
  reading_memory:{ label: "Reading memory…", pulse: true, colorClass: "text-violet-500" },
  compressing:   { label: "Compressing…",  pulse: true,  colorClass: "text-amber-500" },
  cancelling:    { label: "Cancelling…",   pulse: true,  colorClass: "text-destructive" },
};

interface DashboardHeaderProps {
  activeTitle: string;
  agentStatus: AgentStatus;
  conversationStatus: string | null;
  isBusy: boolean;
  onNavigateToMemories: () => void;
  onToggleThemeMode: () => void;
  themeMode: ThemeMode;
}

export function DashboardHeader({
  activeTitle,
  agentStatus,
  isBusy,
  onNavigateToMemories,
  onToggleThemeMode,
  themeMode,
}: DashboardHeaderProps) {
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [instructions, setInstructions] = useState(() => localStorage.getItem(INSTRUCTIONS_KEY) ?? "");
  const meta = STATUS_META[agentStatus];

  useEffect(() => {
    getServerInfo().then(setServerInfo).catch(() => {});
  }, []);

  const handleSaveInstructions = () => {
    const trimmed = instructions.trim();
    if (trimmed) {
      localStorage.setItem(INSTRUCTIONS_KEY, trimmed);
    } else {
      localStorage.removeItem(INSTRUCTIONS_KEY);
    }
    setSettingsOpen(false);
  };

  return (
    <>
      <header className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate font-heading text-xl leading-tight">{activeTitle}</h1>
          <div className="flex items-center gap-2">
            <span className={cn("flex items-center gap-1.5 text-xs font-medium", meta.colorClass)}>
              {meta.pulse ? (
                <span className="relative flex size-1.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                </span>
              ) : (
                <span className="size-1.5 shrink-0 rounded-full bg-current opacity-40" />
              )}
              {meta.label}
            </span>
            {serverInfo ? (
              <>
                <span className="text-muted-foreground/40 text-xs">&middot;</span>
                <span className="truncate text-muted-foreground/70 text-xs" title={serverInfo.provider + " / " + serverInfo.model}>
                  {serverInfo.model}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button onClick={onNavigateToMemories} size="sm" title="View agent memories" variant="outline">
            <DatabaseIcon className="size-4" />
            <span className="hidden sm:inline">Memory</span>
          </Button>
          <Button onClick={() => setSettingsOpen(true)} size="sm" title="Settings &amp; custom instructions" variant="outline">
            <SettingsIcon className="size-4" />
            <span className="hidden sm:inline">Settings</span>
          </Button>
          <Button onClick={onToggleThemeMode} size="sm" variant="outline">
            {themeMode === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
        </div>
      </header>

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-sm font-medium">Custom instructions</p>
              <p className="mb-3 text-muted-foreground text-xs">
                These instructions are appended to the agent&apos;s system prompt as high-priority rules. Leave blank to use defaults only.
              </p>
              <Textarea
                className="min-h-36 resize-y font-mono text-sm"
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={"Example:\n- Always respond in Spanish.\n- Prefer Firefox over the terminal for web tasks."}
                value={instructions}
              />
            </div>
            {serverInfo ? (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs space-y-1">
                <p><span className="text-muted-foreground">Model:</span> <span className="font-mono">{serverInfo.model}</span></p>
                <p><span className="text-muted-foreground">Provider:</span> <span className="font-mono">{serverInfo.provider}</span></p>
                <p><span className="text-muted-foreground">Embed model:</span> <span className="font-mono">{serverInfo.embedModel}</span></p>
                <p><span className="text-muted-foreground">Summary trigger:</span> {serverInfo.summaryTriggerTokens.toLocaleString()} tokens</p>
                <p>
                  <span className="text-muted-foreground">Context window:</span>{' '}
                  {serverInfo.contextWindowTokens
                    ? `${serverInfo.contextWindowTokens.toLocaleString()} tokens`
                    : 'Provider metadata unavailable'}
                  <span className="text-muted-foreground"> ({serverInfo.summaryTriggerSource})</span>
                </p>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setSettingsOpen(false)} variant="outline">Cancel</Button>
              <Button onClick={handleSaveInstructions}>Save instructions</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
