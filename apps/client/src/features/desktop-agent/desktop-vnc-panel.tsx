import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface DesktopVncPanelProps {
  vncUrl: string;
}

export function DesktopVncPanel({ vncUrl }: DesktopVncPanelProps) {
  return (
    <Card
      className="h-full min-h-0 overflow-hidden border-border/70 bg-card/80"
      size="sm"
    >
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="text-base">Desktop VNC Embed</CardTitle>
        <CardDescription>
          Live desktop environment controlled only by agent tool calls
        </CardDescription>
      </CardHeader>
      <CardContent className="h-full min-h-0 p-0">
        <iframe
          className="block h-full min-h-0 w-full rounded-b-2xl bg-black"
          src={vncUrl}
          title="Desktop VNC"
        />
      </CardContent>
    </Card>
  );
}
