import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-400/50 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-teal-500 text-slate-950 hover:bg-teal-400',
        secondary: 'bg-[#171d24] text-[#e7ebef] hover:bg-[#202832]',
        ghost: 'text-[#9ba4af] hover:bg-white/[0.06] hover:text-[#f1f3f5]',
        outline: 'border border-white/[0.1] bg-transparent text-[#d7dde3] hover:bg-white/[0.05]',
        destructive: 'bg-red-500/15 text-red-300 hover:bg-red-500/25',
        link: 'text-teal-300 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 rounded-md px-2.5 text-xs',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
