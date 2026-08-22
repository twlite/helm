import { useState } from 'react';
import { BrainIcon, CheckIcon } from 'lucide-react';
import type { RunReasoningSetting } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface ReasoningModeSelectorProps {
  disabled?: boolean;
  onChange: (mode: RunReasoningSetting) => void;
  value: RunReasoningSetting;
}

const REASONING_MODES: Array<{
  description: string;
  label: string;
  value: RunReasoningSetting;
}> = [
  {
    description: 'Let the provider choose its default reasoning budget.',
    label: 'Default',
    value: 'on',
  },
  {
    description: 'Use a smaller reasoning budget for quicker responses.',
    label: 'Low',
    value: 'low',
  },
  {
    description: 'Balance response depth and speed.',
    label: 'Medium',
    value: 'medium',
  },
  {
    description: 'Use the largest available reasoning budget.',
    label: 'High',
    value: 'high',
  },
  {
    description: 'Skip reasoning output for the fastest response.',
    label: 'Off',
    value: 'off',
  },
];

const getReasoningMode = (value: RunReasoningSetting) =>
  REASONING_MODES.find((mode) => mode.value === value) ?? REASONING_MODES[0];

export function ReasoningModeSelector({
  disabled = false,
  onChange,
  value,
}: ReasoningModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = getReasoningMode(value);

  const select = (mode: RunReasoningSetting) => {
    onChange(mode);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            aria-label={`Reasoning mode: ${selected.label}`}
            className={cn(
              'text-muted-foreground hover:text-foreground',
              value === 'off' && 'text-muted-foreground/70',
            )}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
      }
      >
        <BrainIcon className="size-4 shrink-0" />
        <span className="sr-only">{selected.label}</span>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-1.5" side="top" sideOffset={8}>
        <div className="px-2.5 py-2">
          <p className="font-medium text-sm">Reasoning mode</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Choose how much deliberate reasoning Helm requests for the next run.
          </p>
        </div>
        <div className="space-y-0.5">
          {REASONING_MODES.map((mode) => (
            <button
              className={cn(
                'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted',
                mode.value === value && 'bg-muted',
              )}
              key={mode.value}
              onClick={() => select(mode.value)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-sm">{mode.label}</span>
                <span className="mt-0.5 block text-muted-foreground text-[11px]">
                  {mode.description}
                </span>
              </span>
              {mode.value === value ? (
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
