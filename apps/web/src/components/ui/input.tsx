import * as React from 'react';
import { cn } from '../../lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-white/[0.1] bg-[#11151b] px-3 text-sm text-[#f1f3f5] shadow-sm outline-none transition-colors placeholder:text-[#606975] focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/15 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
