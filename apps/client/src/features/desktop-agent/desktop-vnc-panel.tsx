import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface DesktopVncPanelProps {
  vncUrl: string;
  isActive?: boolean;
}

export function DesktopVncPanel({ vncUrl, isActive = false }: DesktopVncPanelProps) {
  return (
    <Card className="relative h-full min-h-0 overflow-hidden border-border/70 bg-card/80" size="sm">
      <CardContent className="h-full min-h-0 p-0">
        <iframe
          className="block h-full min-h-0 w-full rounded-2xl bg-black"
          src={vncUrl}
          title="Desktop VNC"
        />

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
