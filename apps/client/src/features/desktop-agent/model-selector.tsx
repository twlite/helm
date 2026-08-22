import { useState } from 'react';
import type { ContextSummaryStats, ModelOption, ServerInfo } from '@/lib/api';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  StarIcon,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface ModelSelectorProps {
  contextSummary: ContextSummaryStats | null;
  disabled?: boolean;
  modelId: string;
  onSelect: (modelId: string) => void;
  serverInfo: ServerInfo | null;
}

const formatTokens = (value: number | null): string => {
  if (!value) {
    return 'Unknown';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }

  return value.toLocaleString();
};

const ModelMark = ({ className }: { className?: string }) => (
  <span
    className={cn(
      'flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary',
      className,
    )}
  >
    <CpuIcon className="size-3.5" />
  </span>
);

const providerModels = (models: ModelOption[]) => {
  const groups = new Map<string, { label: string; models: ModelOption[] }>();

  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(model.provider, {
        label: model.providerLabel,
        models: [model],
      });
    }
  }

  return [...groups.entries()];
};

export function ModelSelector({
  contextSummary,
  disabled = false,
  modelId,
  onSelect,
  serverInfo,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const models = serverInfo?.models ?? [];
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  const groups = providerModels(models);
  const modelOrder = new Map(models.map((model, index) => [model.id, index + 1]));

  const activeTokens = contextSummary
    ? contextSummary.activeTokenEstimate + contextSummary.summaryTokenEstimate
    : null;
  const contextUsage = selected?.contextWindowTokens
    ? Math.min(100, Math.round(((activeTokens ?? 0) / selected.contextWindowTokens) * 100))
    : contextSummary?.usagePercent ?? 0;

  const select = (nextModelId: string) => {
    onSelect(nextModelId);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        disabled={disabled || models.length === 0}
        render={
          <Button
            aria-label={selected ? `Select model, currently ${selected.label}` : 'Select model'}
            className="max-w-52 justify-start text-muted-foreground hover:text-foreground"
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <ModelMark />
        <span className="truncate">{selected?.label ?? 'Loading models…'}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[min(430px,calc(100vw-2rem))] overflow-hidden p-0"
        side="top"
        sideOffset={8}
      >
        <Command className="rounded-2xl p-0">
          <div className="border-b border-border/60 p-2">
            <CommandInput placeholder="Search models…" />
          </div>
          <CommandList className="max-h-80 p-1.5">
            <CommandEmpty className="py-8 text-muted-foreground">No matching models.</CommandEmpty>
            {groups.map(([provider, group]) => (
              <CommandGroup heading={group.label} key={provider}>
                {group.models.map((model) => (
                  <CommandItem
                    className="items-start gap-2.5 px-2.5 py-2.5"
                    key={model.id}
                    onSelect={() => select(model.id)}
                    value={`${model.label} ${model.model} ${model.providerLabel} ${model.provider}`}
                  >
                    <ModelMark className="mt-0.5 size-6 rounded-md bg-muted text-muted-foreground group-data-selected/command-item:bg-primary/12 group-data-selected/command-item:text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{model.label}</span>
                        {model.favorite ? (
                          <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                        ) : null}
                      </div>
                      <p className="truncate text-muted-foreground text-xs">
                        {model.providerLabel} · {model.model}
                      </p>
                      {model.description ? (
                        <p className="mt-1 line-clamp-1 text-muted-foreground/80 text-[11px]">
                          {model.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                      <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {model.shortcut ?? `#${modelOrder.get(model.id) ?? 0}`}
                      </kbd>
                      {model.id === selected?.id ? (
                        <CheckIcon className="size-4 text-primary" />
                      ) : null}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>

          {selected ? (
            <div className="border-t border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Context window</span>
                <span className="font-medium tabular-nums">
                  {formatTokens(selected.contextWindowTokens)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${contextUsage}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>
                  {activeTokens ? `${formatTokens(activeTokens)} used` : 'No conversation usage yet'}
                </span>
                <Badge className="h-4 px-1.5 text-[10px]" variant="outline">
                  {selected.contextWindowTokens ? `${contextUsage}%` : selected.contextWindowSource}
                </Badge>
              </div>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
