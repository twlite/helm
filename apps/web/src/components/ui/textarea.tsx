import * as React from 'react';
import { cn } from '../../lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        'flex min-h-20 w-full resize-y rounded-md border border-white/[0.1] bg-[#11151b] px-3 py-2 text-sm text-[#f1f3f5] shadow-sm outline-none transition-colors placeholder:text-[#606975] focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/15 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
