import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] text-xs font-medium transition-colors duration-100 outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--app-bg)] disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent)] text-[#07110f] hover:brightness-110',
        secondary: 'border border-[var(--border)] bg-[var(--pane-raised)] text-[var(--text)] hover:bg-[var(--hover-bg)] hover:border-[var(--border-strong)]',
        ghost: 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]',
        outline: 'border border-[var(--border-strong)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]',
        destructive: 'text-[var(--danger)] hover:bg-red-400/[0.08]',
        link: 'text-[var(--accent)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-[11px]',
        lg: 'h-9 px-4',
        icon: 'size-8',
        'icon-sm': 'size-7',
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
