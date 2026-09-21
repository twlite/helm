import * as React from 'react';
import { cn } from '../../lib/utils';

function Alert({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('relative w-full rounded-lg border px-3 py-2.5 text-sm', className)}
      role="alert"
      {...props}
    />
  );
}

export { Alert };
