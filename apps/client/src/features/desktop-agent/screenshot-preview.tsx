import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface ScreenshotPreviewProps {
  base64: string;
  cursor?: {
    x: number;
    y: number;
  } | null;
  geometry?: {
    height: number;
    width: number;
  } | null;
  mediaType: string;
  toolName: string;
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export function ScreenshotPreview({
  base64,
  cursor,
  geometry,
  mediaType,
  toolName,
}: ScreenshotPreviewProps) {
  const [open, setOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      {
        rootMargin: '300px',
      },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const imageSrc = useMemo(
    () => `data:${mediaType};base64,${base64}`,
    [base64, mediaType],
  );

  const sizeKb = Math.round(base64.length / 1024);
  const cursorPosition = useMemo(() => {
    if (!cursor || !geometry || geometry.width <= 0 || geometry.height <= 0) {
      return null;
    }

    const left = clamp((cursor.x / geometry.width) * 100, 0, 100);
    const top = clamp((cursor.y / geometry.height) * 100, 0, 100);

    return {
      left,
      top,
    };
  }, [cursor, geometry]);

  return (
    <div className="space-y-2" ref={containerRef}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Screenshot ({sizeKb}KB)
      </h4>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogTrigger className="block w-full" type="button">
          {isVisible ? (
            <div className="relative overflow-hidden rounded-lg border border-border/70 bg-muted/20">
              <img
                alt={`${toolName} screenshot thumbnail`}
                className="max-h-48 w-full object-contain"
                decoding="async"
                loading="lazy"
                src={imageSrc}
              />
              {cursorPosition ? (
                <span
                  aria-hidden={true}
                  className="pointer-events-none absolute z-10 block size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-red-500 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
                  style={{
                    left: `${cursorPosition.left}%`,
                    top: `${cursorPosition.top}%`,
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="h-32 w-full animate-pulse rounded-lg border border-border/70 bg-muted/40" />
          )}
        </DialogTrigger>

        <DialogContent className="max-h-[96dvh] w-[min(96vw,1440px)] max-w-none gap-4 p-3 sm:p-4">
          <DialogTitle>Captured screenshot</DialogTitle>
          <DialogDescription>Click outside to close.</DialogDescription>
          {open ? (
            <div className="flex max-h-[calc(96dvh-5.75rem)] justify-center overflow-auto rounded-lg border border-border/70 bg-muted/20">
              <div className="relative inline-block max-w-full">
                <img
                  alt={`${toolName} screenshot full view`}
                  className="block max-h-[calc(96dvh-5.75rem)] max-w-full object-contain"
                  decoding="async"
                  loading="lazy"
                  src={imageSrc}
                />
                {cursorPosition ? (
                  <span
                    aria-hidden={true}
                    className="pointer-events-none absolute z-10 block size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-red-500 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
                    style={{
                      left: `${cursorPosition.left}%`,
                      top: `${cursorPosition.top}%`,
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
