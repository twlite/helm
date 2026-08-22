import { useEffect, useMemo, useRef, useState } from "react";
import { CameraIcon, CropIcon, WandSparklesIcon } from "lucide-react";
import {
  usePromptInputController,
  useProviderAttachments,
} from "@/components/ai-elements/prompt-input";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { captureDesktopScreenshot } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DesktopAnnotationDialog } from "./desktop-annotation-dialog";

export interface AgentCursorPosition {
  clickKey: string | null;
  eventKey: string;
  height: number;
  isClicking: boolean;
  width: number;
  xPercent: number;
  yPercent: number;
}

const dataUrlToFile = async (dataUrl: string, filename: string): Promise<File> => {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, {
    lastModified: Date.now(),
    type: blob.type || "image/png",
  });
};

interface DesktopVncPanelProps {
  vncUrl: string;
  isActive?: boolean;
  agentCursor?: AgentCursorPosition | null;
  screenshotFlashKey?: string | null;
}

export function DesktopVncPanel({
  agentCursor,
  screenshotFlashKey,
  vncUrl,
  isActive = false,
}: DesktopVncPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const attachments = useProviderAttachments();
  const { textInput } = usePromptInputController();
  const [containerSize, setContainerSize] = useState({ height: 0, width: 0 });
  const [isCapturing, setIsCapturing] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [annotationDataUrl, setAnnotationDataUrl] = useState<string | null>(null);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const desktopWidth = agentCursor?.width && agentCursor.width > 0 ? agentCursor.width : 1366;
  const desktopHeight = agentCursor?.height && agentCursor.height > 0 ? agentCursor.height : 768;
  const desktopRect = useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return { height: "100%", width: "100%" };
    }

    const availableHeight = Math.max(1, containerSize.height - toolbarHeight - 12);
    const aspectRatio = desktopWidth / desktopHeight;
    const containerAspectRatio = containerSize.width / availableHeight;

    if (containerAspectRatio > aspectRatio) {
      const height = availableHeight;
      return { height, width: height * aspectRatio };
    }

    const width = containerSize.width;
    return { height: width / aspectRatio, width };
  }, [containerSize.height, containerSize.width, desktopHeight, desktopWidth, toolbarHeight]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const toolbarRect = toolbarRef.current?.getBoundingClientRect();
      setContainerSize({
        height: rect.height,
        width: rect.width,
      });
      setToolbarHeight(toolbarRect?.height ?? 0);
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(element);
    if (toolbarRef.current) {
      resizeObserver.observe(toolbarRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const focusPrompt = () => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
    });
  };

  const addToPrompt = async (file: File, promptHint: string | null = null) => {
    attachments.add([file]);
    if (promptHint && !textInput.value.trim()) {
      textInput.setInput(promptHint);
    }
    focusPrompt();
  };

  const handleCapture = async () => {
    setIsCapturing(true);
    setToolError(null);
    setToolStatus(null);
    try {
      const screenshot = await captureDesktopScreenshot();
      const file = await dataUrlToFile(screenshot.dataUrl, screenshot.filename);
      await addToPrompt(file);
      setToolStatus("Screenshot added to the prompt");
    } catch (error) {
      setToolError(error instanceof Error ? error.message : "Screenshot capture failed");
    } finally {
      setIsCapturing(false);
    }
  };

  const handleAnnotate = async () => {
    setIsCapturing(true);
    setToolError(null);
    setToolStatus(null);
    try {
      const screenshot = await captureDesktopScreenshot();
      setAnnotationDataUrl(screenshot.dataUrl);
      setAnnotationOpen(true);
      setToolStatus("Choose a region or draw on the capture");
    } catch (error) {
      setToolError(error instanceof Error ? error.message : "Screenshot capture failed");
    } finally {
      setIsCapturing(false);
    }
  };

  const handleAnnotationOpenChange = (open: boolean) => {
    setAnnotationOpen(open);
    if (!open) {
      setAnnotationDataUrl(null);
    }
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full flex-col items-start gap-3 overflow-hidden">
      <Card
        className="relative min-h-0 overflow-hidden border-border/70 bg-black !p-0"
        size="sm"
        style={{
          height: desktopRect.height,
          width: desktopRect.width,
        }}
      >
        <CardContent className="relative h-full min-h-0 overflow-hidden rounded-2xl bg-black !p-0">
          <iframe
            className="absolute inset-0 block h-full min-h-0 w-full bg-black"
            src={vncUrl}
            title="Desktop VNC"
          />

          {screenshotFlashKey ? (
            <div
              aria-hidden={true}
              className="pointer-events-none absolute inset-0 z-[45] rounded-2xl border-2 border-cyan-200/55"
              key={screenshotFlashKey}
              style={{
                animation: "helm-screenshot-edge-flash 900ms ease-out 1 both",
                boxShadow: "inset 0 0 30px rgba(34,211,238,0.22), 0 0 18px rgba(34,211,238,0.18)",
              }}
            />
          ) : null}

          {agentCursor ? (
            <div aria-hidden={true} className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
              <div
                className="absolute size-8 drop-shadow-[0_6px_12px_rgba(0,0,0,0.45)] transition-[left,top,opacity] duration-500 ease-out"
                style={{
                  left: `clamp(0px, calc(${agentCursor.xPercent}% - 2px), calc(100% - 32px))`,
                  opacity: isActive ? 1 : 0.72,
                  top: `clamp(0px, calc(${agentCursor.yPercent}% - 2px), calc(100% - 32px))`,
                }}
              >
                {agentCursor.clickKey ? (
                  <span
                    className="absolute left-1 top-1 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-300 bg-sky-400/25"
                    key={agentCursor.clickKey}
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
          ) : null}

          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-40 h-24 transition-opacity duration-700",
              isActive ? "opacity-100" : "opacity-0",
            )}
            style={{
              background: "linear-gradient(to bottom, rgba(59,130,246,0.28) 0%, transparent 100%)",
              animation: isActive ? "helm-haze-pulse 2.4s ease-in-out infinite" : undefined,
            }}
          />
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-40 h-24 transition-opacity duration-700",
              isActive ? "opacity-100" : "opacity-0",
            )}
            style={{
              background: "linear-gradient(to top, rgba(59,130,246,0.28) 0%, transparent 100%)",
              animation: isActive ? "helm-haze-pulse 2.4s ease-in-out infinite 1.2s" : undefined,
            }}
          />
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-40 rounded-2xl border-2 transition-opacity duration-700",
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

      <div
        ref={toolbarRef}
        className="flex w-full shrink-0 items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/75 p-2.5 shadow-sm"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <WandSparklesIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-sm">Desktop tools</p>
            <p className={cn("truncate text-xs", toolError ? "text-destructive" : "text-muted-foreground")}>
              {toolError ?? toolStatus ?? "Capture the desktop or annotate an area for Helm."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            className="gap-1.5"
            disabled={isCapturing}
            onClick={() => void handleCapture()}
            size="sm"
            type="button"
            variant="outline"
          >
            <CameraIcon className="size-3.5" />
            {isCapturing ? "Capturing…" : "Capture screenshot"}
          </Button>
          <Button
            className="gap-1.5"
            disabled={isCapturing}
            onClick={() => void handleAnnotate()}
            size="sm"
            type="button"
          >
            <CropIcon className="size-3.5" />
            Annotate
          </Button>
        </div>
      </div>

      <DesktopAnnotationDialog
        dataUrl={annotationDataUrl ?? ""}
        onAddToPrompt={async (file, promptHint) => {
          await addToPrompt(file, promptHint);
          setToolStatus("Annotated capture added to the prompt");
        }}
        onOpenChange={handleAnnotationOpenChange}
        open={annotationOpen && Boolean(annotationDataUrl)}
      />
    </div>
  );
}
