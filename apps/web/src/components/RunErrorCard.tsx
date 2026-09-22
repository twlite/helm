import { Icon } from './Icon';
import { Button } from './ui/button';

type RunErrorCardProps = {
  title?: string;
  message: string;
  code?: string;
  details?: unknown;
  isRetrying?: boolean;
  onRetry?: () => void | Promise<void>;
  onOpenActivity?: () => void;
};

function detailText(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2) ?? undefined;
  } catch {
    return 'Additional error details could not be displayed.';
  }
}

export function RunErrorCard({
  title = 'Task failed',
  message,
  code,
  details,
  isRetrying = false,
  onRetry,
  onOpenActivity,
}: RunErrorCardProps) {
  const serializedDetails = detailText(details);

  return (
    <section
      aria-label={title}
      className="min-w-0 max-w-full overflow-hidden rounded-xl border border-red-400/25 bg-red-400/[0.07] px-4 py-4 text-red-100"
      role="alert"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-red-400/15 text-red-300">
          <Icon name="triangle" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-red-100/90">{message}</p>
          {code ? <p className="mt-2 font-mono text-[11px] text-red-200/60">{code}</p> : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 pl-10">
        {onRetry ? (
          <Button disabled={isRetrying} onClick={() => void onRetry()} size="sm" variant="destructive">
            <Icon className={isRetrying ? 'animate-spin' : undefined} name="refresh" size={13} />
            {isRetrying ? 'Retrying…' : 'Retry'}
          </Button>
        ) : null}
        {onOpenActivity ? (
          <Button onClick={onOpenActivity} size="sm" variant="ghost">
            <Icon name="activity" size={13} />
            View activity
          </Button>
        ) : null}
      </div>

      {serializedDetails ? (
        <details className="mt-3 pl-10">
          <summary className="cursor-pointer text-xs text-red-200/65 hover:text-red-100">Technical details</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 p-2 font-mono text-[11px] leading-5 text-red-100/70">{serializedDetails}</pre>
        </details>
      ) : null}
    </section>
  );
}
