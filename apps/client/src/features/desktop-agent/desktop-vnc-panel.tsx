import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface AgentCursorPosition {
  eventKey: string;
  isClicking: boolean;
  xPercent: number;
  yPercent: number;
}

interface DesktopVncPanelProps {
  vncUrl: string;
  isActive?: boolean;
  agentCursor?: AgentCursorPosition | null;
}

export function DesktopVncPanel({ agentCursor, vncUrl, isActive = false }: DesktopVncPanelProps) {
  return (
    <Card className="relative h-full min-h-0 overflow-hidden border-border/70 bg-card/80 !p-0" size="sm">
      <CardContent className="relative h-full min-h-0 overflow-hidden !p-0">
        <iframe
          className="absolute inset-0 block h-full min-h-0 w-full rounded-2xl bg-black"
          src={vncUrl}
          title="Desktop VNC"
        />

        {agentCursor ? (
          <div aria-hidden={true} className="pointer-events-none absolute inset-0 z-50">
            <div
              className="absolute drop-shadow-[0_6px_12px_rgba(0,0,0,0.45)] transition-[left,top,opacity] duration-500 ease-out"
              style={{
                left: `${agentCursor.xPercent}%`,
                opacity: isActive ? 1 : 0.72,
                top: `${agentCursor.yPercent}%`,
              }}
            >
              <div className="-translate-x-[2px] -translate-y-[2px]">
                {agentCursor.isClicking ? (
                  <span
                    className="absolute left-1 top-1 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-300 bg-sky-400/25"
                    key={agentCursor.eventKey}
                    style={{ animation: "helm-cursor-click 520ms ease-out 1 forwards" }}
                  />
                ) : null}
                <svg
                  className={cn(
                    "relative size-7 text-white transition-transform duration-150",
                    agentCursor.isClicking ? "scale-90" : "scale-100",
                  )}
                  fill="none"
                  viewBox="0 0 28 28"
                >
                  <path
                    d="M5 3.5 22.5 17l-8.15 1.35L10.4 25 5 3.5Z"
                    fill="currentColor"
                    stroke="rgba(0,0,0,0.75)"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                  <path
                    d="m13.8 17.95 3.6 6.25"
                    stroke="rgba(0,0,0,0.75)"
                    strokeLinecap="round"
                    strokeWidth="3"
                  />
                  <path
                    d="m13.8 17.95 3.6 6.25"
                    stroke="white"
                    strokeLinecap="round"
                    strokeWidth="1.4"
                  />
                </svg>
              </div>
            </div>
          </div>
        ) : null}

        {/* Animated haze overlays — only visible when agent is working */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-2xl transition-opacity duration-700",
            isActive ? "opacity-100" : "opacity-0",
          )}
          style={{
            background: "linear-gradient(to bottom, rgba(59,130,246,0.28) 0%, transparent 100%)",
            animation: isActive ? "helm-haze-pulse 2.4s ease-in-out infinite" : undefined,
          }}
        />
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-24 rounded-b-2xl transition-opacity duration-700",
            isActive ? "opacity-100" : "opacity-0",
          )}
          style={{
            background: "linear-gradient(to top, rgba(59,130,246,0.28) 0%, transparent 100%)",
            animation: isActive ? "helm-haze-pulse 2.4s ease-in-out infinite 1.2s" : undefined,
          }}
        />

        {/* Animated border glow */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 rounded-2xl border-2 transition-opacity duration-700",
            isActive ? "opacity-100" : "opacity-0",
          )}
          style={{
            borderColor: "rgba(59,130,246,0.45)",
            boxShadow: "inset 0 0 24px rgba(59,130,246,0.12)",
            animation: isActive ? "helm-haze-pulse 2.4s ease-in-out infinite" : undefined,
          }}
        />
      </CardContent>
    </Card>
  );
}
