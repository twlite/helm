import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  CropIcon,
  EraserIcon,
  MousePointer2Icon,
  PencilIcon,
  RotateCcwIcon,
  WandSparklesIcon,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AnnotationMode = 'draw' | 'region' | 'select';

interface Point {
  x: number;
  y: number;
}

interface SelectionRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface DesktopAnnotationDialogProps {
  dataUrl: string;
  onAddToPrompt: (file: File, promptHint: string | null) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The screenshot could not be read.'));
    image.src = src;
  });

const toFile = async (canvas: HTMLCanvasElement, filename: string) => {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });

  if (!blob) {
    throw new Error('The annotated screenshot could not be created.');
  }

  return new File([blob], filename, {
    lastModified: Date.now(),
    type: 'image/png',
  });
};

const normalizeSelection = (start: Point, end: Point): SelectionRect => ({
  height: Math.abs(end.y - start.y),
  width: Math.abs(end.x - start.x),
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
});

const TOOL_OPTIONS: Array<{
  icon: typeof MousePointer2Icon;
  label: string;
  mode: AnnotationMode;
}> = [
  { icon: MousePointer2Icon, label: 'Select', mode: 'select' },
  { icon: CropIcon, label: 'Region', mode: 'region' },
  { icon: PencilIcon, label: 'Draw', mode: 'draw' },
];

export function DesktopAnnotationDialog({
  dataUrl,
  onAddToPrompt,
  onOpenChange,
  open,
}: DesktopAnnotationDialogProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [activePath, setActivePath] = useState<Point[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ height: 0, width: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [mode, setMode] = useState<AnnotationMode>('region');
  const [paths, setPaths] = useState<Point[][]>([]);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const interactionRef = useRef<{ start: Point; mode: AnnotationMode } | null>(null);

  const measureFrame = useCallback(() => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return;
    }

    setFrameSize({ height: rect.height, width: rect.width });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    let animationFrame = 0;
    let observer: ResizeObserver | null = null;
    const observeFrame = () => {
      const frame = frameRef.current;
      if (!frame) {
        animationFrame = window.requestAnimationFrame(observeFrame);
        return;
      }

      measureFrame();
      observer = new ResizeObserver(measureFrame);
      observer.observe(frame);
    };

    observeFrame();
    window.addEventListener('resize', measureFrame);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener('resize', measureFrame);
    };
  }, [dataUrl, measureFrame, open]);

  useEffect(() => {
    if (open) {
      return;
    }

    setActivePath([]);
    setError(null);
    setMode('region');
    setPaths([]);
    setSelection(null);
  }, [open]);

  const pointFromEvent = useCallback(
    (event: React.PointerEvent<SVGSVGElement>): Point => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        x: clamp(
          ((event.clientX - rect.left) / rect.width) * frameSize.width,
          0,
          frameSize.width,
        ),
        y: clamp(
          ((event.clientY - rect.top) / rect.height) * frameSize.height,
          0,
          frameSize.height,
        ),
      };
    },
    [frameSize.height, frameSize.width],
  );

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (mode === 'select') {
      return;
    }

    const start = pointFromEvent(event);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable for synthetic or unsupported pointer events.
    }
    interactionRef.current = { mode, start };

    if (mode === 'region') {
      setSelection({ height: 0, width: 0, x: start.x, y: start.y });
      return;
    }

    setActivePath([start]);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) {
      return;
    }

    const point = pointFromEvent(event);
    if (interaction.mode === 'region') {
      setSelection(normalizeSelection(interaction.start, point));
    } else {
      setActivePath((current) => [...current, point]);
    }
  };

  const finishPointerInteraction = (event: React.PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) {
      return;
    }

    const point = pointFromEvent(event);
    if (interaction.mode === 'region') {
      const nextSelection = normalizeSelection(interaction.start, point);
      setSelection(nextSelection.width > 8 && nextSelection.height > 8 ? nextSelection : null);
    } else {
      setActivePath((current) => {
        const nextPath = [...current, point];
        if (nextPath.length > 1) {
          setPaths((existing) => [...existing, nextPath]);
        }
        return [];
      });
    }

    interactionRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Pointer capture is optional; the completed gesture is already recorded.
    }
  };

  const resetAnnotations = () => {
    setActivePath([]);
    setError(null);
    setPaths([]);
    setSelection(null);
  };

  const handleErase = () => {
    setActivePath([]);
    setPaths([]);
    setSelection(null);
    setMode('select');
  };

  const handleExport = async () => {
    if (!dataUrl || isExporting) {
      return;
    }

    setError(null);
    setIsExporting(true);

    try {
      const image = await loadImage(dataUrl);
      const displayWidth = frameSize.width || image.width;
      const displayHeight = frameSize.height || image.height;
      const scaleX = image.width / displayWidth;
      const scaleY = image.height / displayHeight;
      const crop = selection && selection.width > 8 && selection.height > 8
        ? {
            height: Math.round(selection.height * scaleY),
            width: Math.round(selection.width * scaleX),
            x: Math.round(selection.x * scaleX),
            y: Math.round(selection.y * scaleY),
          }
        : { height: image.height, width: image.width, x: 0, y: 0 };
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, crop.width);
      canvas.height = Math.max(1, crop.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('The screenshot editor is unavailable in this browser.');
      }

      context.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );

      const drawPath = (path: Point[]) => {
        if (path.length < 2) {
          return;
        }

        context.beginPath();
        path.forEach((point, index) => {
          const x = (point.x * scaleX - crop.x) * (crop.width / (selection ? selection.width * scaleX : image.width));
          const y = (point.y * scaleY - crop.y) * (crop.height / (selection ? selection.height * scaleY : image.height));
          if (index === 0) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
        });
        context.strokeStyle = '#38bdf8';
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.lineWidth = Math.max(3, image.width / displayWidth * 4);
        context.stroke();
      };

      paths.forEach(drawPath);
      if (activePath.length > 1) {
        drawPath(activePath);
      }

      const file = await toFile(
        canvas,
        selection ? 'desktop-region.png' : 'desktop-annotation.png',
      );
      await onAddToPrompt(
        file,
        selection ? 'Please inspect the selected region and ' : null,
      );
      onOpenChange(false);
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : 'The annotated screenshot could not be added.',
      );
    } finally {
      setIsExporting(false);
    }
  };

  const selectionLabel = selection
    ? `${Math.round(selection.width)} × ${Math.round(selection.height)} selected`
    : 'Drag over the desktop to select a region';

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="w-[min(920px,calc(100%-2rem))] max-w-none gap-4 p-4 sm:p-5">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <WandSparklesIcon className="size-4 text-primary" />
            Annotate desktop capture
          </DialogTitle>
          <DialogDescription>
            Select the area Helm should focus on, draw a quick mark, then add it to your prompt.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/25 p-1.5">
          <div className="flex items-center gap-1">
            {TOOL_OPTIONS.map(({ icon: Icon, label, mode: toolMode }) => (
              <Button
                aria-pressed={mode === toolMode}
                className={cn(
                  'h-8 gap-1.5 px-2.5 text-xs',
                  mode === toolMode && 'bg-primary/12 text-primary hover:bg-primary/18',
                )}
                key={toolMode}
                onClick={() => setMode(toolMode)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
            <Button
              className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground"
              onClick={handleErase}
              size="sm"
              type="button"
              variant="ghost"
            >
              <EraserIcon className="size-3.5" />
              Erase
            </Button>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            {selection ? <CheckIcon className="size-3.5 text-primary" /> : null}
            <span>{selectionLabel}</span>
          </div>
        </div>

        <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-2xl border border-border/70 bg-black/80 p-2">
          <div ref={frameRef} className="relative max-h-[56vh] max-w-full overflow-hidden rounded-xl">
            {dataUrl ? (
              <img
                alt="Desktop screenshot to annotate"
                className="block max-h-[56vh] max-w-full select-none object-contain"
                draggable={false}
                onLoad={measureFrame}
                src={dataUrl}
              />
            ) : null}
            {frameSize.width > 0 && frameSize.height > 0 ? (
              <svg
                aria-label="Screenshot annotation surface"
                className={cn(
                  'absolute inset-0 h-full w-full touch-none',
                  mode === 'select' ? 'cursor-default' : 'cursor-crosshair',
                )}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerInteraction}
                onPointerCancel={finishPointerInteraction}
                viewBox={`0 0 ${frameSize.width} ${frameSize.height}`}
              >
                {paths.map((path, index) => (
                  <polyline
                    fill="none"
                    key={`path-${index}`}
                    points={path.map((point) => `${point.x},${point.y}`).join(' ')}
                    stroke="#38bdf8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={Math.max(2, frameSize.width / 320)}
                  />
                ))}
                {activePath.length > 1 ? (
                  <polyline
                    fill="none"
                    points={activePath.map((point) => `${point.x},${point.y}`).join(' ')}
                    stroke="#7dd3fc"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={Math.max(2, frameSize.width / 320)}
                  />
                ) : null}
                {selection ? (
                  <rect
                    fill="rgba(56,189,248,0.18)"
                    height={selection.height}
                    stroke="#38bdf8"
                    strokeDasharray="6 4"
                    strokeWidth={Math.max(2, frameSize.width / 420)}
                    width={selection.width}
                    x={selection.x}
                    y={selection.y}
                  />
                ) : null}
              </svg>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {error}
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <Button
            className="gap-1.5 text-muted-foreground"
            onClick={resetAnnotations}
            type="button"
            variant="ghost"
          >
            <RotateCcwIcon className="size-3.5" />
            Reset marks
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button className="gap-1.5" disabled={isExporting || !dataUrl} onClick={() => void handleExport()} type="button">
              <WandSparklesIcon className="size-3.5" />
              {isExporting
                ? 'Preparing…'
                : selection
                  ? 'Add region to prompt'
                  : 'Add screenshot to prompt'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
