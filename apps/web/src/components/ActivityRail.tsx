import { memo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CompletionCriterion } from '@helm/shared';
import type { HealthStatus, Memory, MemoryKind, RunDetails, RunStep, VmAction, VmStatus } from '../types';
import { formatDate, humanize } from '../format';
import { Icon } from './Icon';

type ActivityRailProps = {
  run: RunDetails | null;
  vm: VmStatus | null;
  health: HealthStatus | null;
  screenshot: string | null;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  reconnectAttempt: number;
  vmAction: VmAction | null;
  onVmAction: (action: VmAction) => Promise<void>;
  onRefreshDiagnostics: () => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  memories: Memory[];
  memoryQuery: string;
  memoryLoading: boolean;
  memoryActionId: string | null;
  onMemoryQueryChange: (value: string) => void;
  onSearchMemories: (query: string) => Promise<void>;
  onAddMemory: (input: { content: string; kind: MemoryKind; importance: number }) => Promise<boolean>;
  onDeleteMemory: (memoryId: string) => Promise<void>;
};

function displayValue(value: unknown, empty = 'No data recorded') {
  if (value === undefined || value === null || value === '') {
    return empty;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? empty;
  } catch {
    return 'Unable to display this value';
  }
}

function statusTone(value: string): string {
  if (['running', 'connected', 'completed', 'ok'].includes(value)) {
    return 'is-good';
  }
  if (['starting', 'stopping', 'reconnecting', 'pending'].includes(value)) {
    return 'is-warn';
  }
  if (['failed', 'blocked', 'cancelled', 'error', 'offline', 'unavailable'].includes(value)) {
    return 'is-bad';
  }
  return 'is-muted';
}

function criterionLabel(criterion: CompletionCriterion): string {
  switch (criterion.type) {
    case 'browser.url':
      return `Browser URL is ${criterion.url}`;
    case 'file.exists':
      return `File exists: ${criterion.path}`;
    case 'file.contains':
      return `File contains expected content: ${criterion.path}`;
    case 'window.open':
      return `Window open${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'window.focused':
      return `Window focused${criterion.titleIncludes ? `: ${criterion.titleIncludes}` : ''}`;
    case 'custom':
      return criterion.description;
  }
}

function renderAction(step: RunStep): string {
  if (step.decision?.type === 'action') {
    return `${step.decision.tool}\n${displayValue(step.decision.input)}`;
  }
  if (step.toolName) {
    return `${step.toolName}\n${displayValue(step.toolInput)}`;
  }
  if (step.decision?.type === 'complete') {
    return 'completion requested';
  }
  if (step.decision?.type === 'blocked') {
    return `blocked\n${step.decision.reason}`;
  }
  return 'No action recorded';
}

const TraceStep = memo(function TraceStep({ step }: { step: RunStep }) {
  const reason = step.decision?.reasoningSummary;
  const observation = step.observation ?? step.toolResult;
  const verification = step.verification;
  return (
    <article className="helm-trace-step">
      <div className="helm-trace-step-heading">
        <span className="helm-trace-number">{String(step.stepIndex + 1).padStart(2, '0')}</span>
        <span className={`helm-status-chip ${statusTone(step.phase)}`}>{humanize(step.phase)}</span>
        <span className="helm-trace-time">{formatDate(step.createdAt)}</span>
      </div>
      <div className="helm-trace-grid">
        <div className="helm-trace-block helm-trace-reason">
          <span className="helm-trace-label">Reason</span>
          <p>{reason ?? 'Operational decision recorded by the provider.'}</p>
        </div>
        <div className="helm-trace-block helm-trace-action">
          <span className="helm-trace-label">Action</span>
          <pre>{renderAction(step)}</pre>
        </div>
        <div className="helm-trace-block helm-trace-observation">
          <span className="helm-trace-label">Observation</span>
          <pre>{displayValue(observation)}</pre>
        </div>
        <div className="helm-trace-block helm-trace-verification">
          <span className="helm-trace-label">Verification</span>
          {verification ? (
            <div className="helm-criteria-list">
              {verification.criteria.map((criterion, index) => (
                <div className="helm-criterion-row" key={`${criterionLabel(criterion.criterion)}-${index}`}>
                  <span className={criterion.passed ? 'helm-check-mark is-good' : 'helm-check-mark is-bad'}>
                    <Icon name={criterion.passed ? 'check' : 'x'} size={12} />
                  </span>
                  <span>{criterion.message || criterionLabel(criterion.criterion)}</span>
                </div>
              ))}
              <small>{verification.summary}</small>
            </div>
          ) : (
            <p>No verification recorded for this step.</p>
          )}
        </div>
      </div>
    </article>
  );
});

function RunTrace({ run, onCancelRun }: { run: RunDetails; onCancelRun: (runId: string) => Promise<void> }) {
  const sortedSteps = [...run.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  return (
    <section className="helm-activity-section helm-trace-section">
      <div className="helm-activity-section-header">
        <div>
          <p className="helm-section-label">Live run</p>
          <h3>Agent activity</h3>
        </div>
        <span className={`helm-status-chip ${statusTone(run.status)}`}>{humanize(run.status)}</span>
      </div>
      <div className="helm-run-goal">
        <span className="helm-run-goal-icon"><Icon name="target" size={15} /></span>
        <span>{run.goal || 'Scripted runtime task'}</span>
      </div>
      {run.status === 'running' || run.status === 'pending' ? (
        <button className="helm-button helm-button-danger-soft" onClick={() => void onCancelRun(run.id)} type="button">
          <Icon name="square" size={13} /> Cancel run
        </button>
      ) : null}
      {sortedSteps.length > 0 ? (
        <div className="helm-trace-list">
          {sortedSteps.map((step) => <TraceStep key={step.id} step={step} />)}
        </div>
      ) : (
        <div className="helm-inline-empty"><span className="helm-spinner" /> Waiting for the first observation…</div>
      )}
      {run.error ? <div className="helm-error-box">{run.error.message}</div> : null}
    </section>
  );
}

function VmCard({
  vm,
  screenshot,
  vmAction,
  onVmAction,
}: Pick<ActivityRailProps, 'vm' | 'screenshot' | 'vmAction' | 'onVmAction'>) {
  const state = vm?.state ?? 'unavailable';
  return (
    <section className="helm-activity-section helm-vm-section">
      <div className="helm-activity-section-header">
        <div>
          <p className="helm-section-label">Environment</p>
          <h3>Virtual machine</h3>
        </div>
        <span className={`helm-state-dot-label ${statusTone(state)}`}>
          <span className="helm-status-dot" /> {humanize(state)}
        </span>
      </div>
      <div className="helm-vm-preview">
        {screenshot ? (
          <img alt="Latest Linux guest desktop screenshot" src={screenshot} />
        ) : (
          <div className="helm-vm-placeholder">
            <Icon name="monitor" size={22} />
            <span>{state === 'unavailable' ? 'VM helper unavailable' : 'No desktop screenshot yet'}</span>
          </div>
        )}
        <span className="helm-vm-overlay-label">LIVE DESKTOP</span>
      </div>
      <div className="helm-vm-details">
        <div><span>Guest</span><strong>{vm?.guestConnected ? 'Connected' : 'Not connected'}</strong></div>
        <div><span>Helper</span><strong>{vm?.helperAvailable ? 'Ready' : 'Unavailable'}</strong></div>
      </div>
      {vm?.message ? <p className="helm-muted-copy">{vm.message}</p> : null}
      <div className="helm-vm-actions">
        <button
          className="helm-button helm-button-quiet"
          disabled={vmAction !== null || state === 'running' || state === 'starting'}
          onClick={() => void onVmAction('start')}
          type="button"
        >
          <Icon name="play" size={13} /> Start
        </button>
        <button
          className="helm-button helm-button-quiet"
          disabled={vmAction !== null || state === 'stopped' || state === 'stopping' || state === 'unavailable'}
          onClick={() => void onVmAction('stop')}
          type="button"
        >
          <Icon name="square" size={12} /> Stop
        </button>
        <button
          className="helm-button helm-button-quiet"
          disabled={vmAction !== null}
          onClick={() => void onVmAction('reset')}
          type="button"
        >
          <Icon name="refresh" size={13} /> Reset
        </button>
      </div>
    </section>
  );
}

const diagnosticRows: Array<{ key: keyof HealthStatus; label: string }> = [
  { key: 'database', label: 'SQLite database' },
  { key: 'fts5', label: 'FTS5 search' },
  { key: 'sqliteVec', label: 'sqlite-vec adapter' },
  { key: 'vmHelper', label: 'VM helper' },
  { key: 'browser', label: 'Browser session' },
  { key: 'desktop', label: 'Desktop session' },
];

function HealthCard({ health, connectionState, reconnectAttempt, onRefreshDiagnostics }: Pick<ActivityRailProps, 'health' | 'connectionState' | 'reconnectAttempt' | 'onRefreshDiagnostics'>) {
  return (
    <section className="helm-activity-section helm-health-section">
      <div className="helm-activity-section-header">
        <div>
          <p className="helm-section-label">Diagnostics</p>
          <h3>System health</h3>
        </div>
        <button aria-label="Refresh diagnostics" className="helm-icon-button" onClick={() => void onRefreshDiagnostics()} type="button">
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <div className="helm-health-summary">
        <span className={`helm-health-orb ${health?.ok ? 'is-good' : 'is-muted'}`}><Icon name="activity" size={15} /></span>
        <div><strong>{health?.ok ? 'Healthy boundary' : 'Waiting for backend'}</strong><span>API checks and capabilities</span></div>
      </div>
      <div className="helm-diagnostic-list">
        {diagnosticRows.map((row) => {
          const isGood = health?.[row.key] === true;
          return <div className="helm-diagnostic-row" key={row.key}><span className={`helm-status-dot ${isGood ? 'is-live' : 'is-muted'}`} /><span>{row.label}</span><em>{isGood ? 'Ready' : '—'}</em></div>;
        })}
        <div className="helm-diagnostic-row"><span className={`helm-status-dot ${connectionState === 'connected' ? 'is-live' : 'is-muted'}`} /><span>Event stream</span><em>{connectionState === 'connected' ? 'Connected' : connectionState === 'reconnecting' ? `Retry ${reconnectAttempt}` : humanize(connectionState)}</em></div>
      </div>
    </section>
  );
}

function MemoryCard({
  memories,
  memoryQuery,
  memoryLoading,
  memoryActionId,
  onMemoryQueryChange,
  onSearchMemories,
  onAddMemory,
  onDeleteMemory,
}: Pick<ActivityRailProps, 'memories' | 'memoryQuery' | 'memoryLoading' | 'memoryActionId' | 'onMemoryQueryChange' | 'onSearchMemories' | 'onAddMemory' | 'onDeleteMemory'>) {
  const [isAdding, setIsAdding] = useState(false);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('note');
  const [importance, setImportance] = useState(0.5);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSearchMemories(memoryQuery.trim());
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      return;
    }
    const saved = await onAddMemory({ content: content.trim(), kind, importance });
    if (saved) {
      setContent('');
      setImportance(0.5);
      setKind('note');
      setIsAdding(false);
    }
  }

  return (
    <section className="helm-activity-section helm-memory-section">
      <div className="helm-activity-section-header">
        <div>
          <p className="helm-section-label">Cross-thread context</p>
          <h3>Memory</h3>
        </div>
        <button className="helm-icon-button" onClick={() => setIsAdding((current) => !current)} type="button">
          <Icon name={isAdding ? 'x' : 'plus'} size={16} />
        </button>
      </div>
      <form className="helm-memory-search" onSubmit={(event) => void handleSearch(event)}>
        <Icon name="search" size={14} />
        <input aria-label="Search memories" onChange={(event) => onMemoryQueryChange(event.target.value)} placeholder="Search memories" value={memoryQuery} />
        <button aria-label="Search" className="helm-icon-button" disabled={memoryLoading} type="submit"><Icon name="arrow-up" size={14} /></button>
      </form>
      {isAdding ? (
        <form className="helm-memory-form" onSubmit={(event) => void handleAdd(event)}>
          <textarea aria-label="Memory content" onChange={(event) => setContent(event.target.value)} placeholder="A durable fact or preference…" rows={3} value={content} />
          <div className="helm-memory-form-row">
            <select aria-label="Memory kind" onChange={(event) => setKind(event.target.value as MemoryKind)} value={kind}>
              <option value="note">Note</option>
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
              <option value="instruction">Instruction</option>
            </select>
            <label className="helm-importance-label">Importance <input aria-label="Importance" max="1" min="0" onChange={(event) => setImportance(Number(event.target.value))} step="0.1" type="number" value={importance} /></label>
          </div>
          <button className="helm-button helm-button-primary helm-button-small" disabled={!content.trim()} type="submit"><Icon name="plus" size={13} /> Save memory</button>
        </form>
      ) : null}
      <div className="helm-memory-list">
        {memoryLoading ? <div className="helm-inline-empty"><span className="helm-spinner" /> Loading memory…</div> : memories.length > 0 ? memories.map((memory) => (
          <article className="helm-memory-row" key={memory.id}>
            <div className="helm-memory-row-top"><span className="helm-memory-kind">{memory.kind}</span><button aria-label={`Delete memory: ${memory.content.slice(0, 20)}`} className="helm-icon-button helm-delete-button" disabled={memoryActionId === memory.id} onClick={() => void onDeleteMemory(memory.id)} type="button"><Icon name="trash" size={13} /></button></div>
            <p>{memory.content}</p>
            <small>{Math.round(memory.importance * 100)}% importance · {formatDate(memory.updatedAt || memory.createdAt)}</small>
          </article>
        )) : <div className="helm-inline-empty">No memories match this view.</div>}
      </div>
    </section>
  );
}

export function ActivityRail(props: ActivityRailProps) {
  return (
    <aside className="helm-activity-panel" aria-label="Agent activity and controls">
      <div className="helm-activity-header">
        <div>
          <p className="helm-section-label">Operations</p>
          <h2>Control room</h2>
        </div>
        <span className={`helm-live-label ${props.connectionState === 'connected' ? 'is-connected' : ''}`}><span className="helm-status-dot" /> {props.connectionState === 'connected' ? 'Live' : humanize(props.connectionState)}</span>
      </div>
      {props.run ? <RunTrace onCancelRun={props.onCancelRun} run={props.run} /> : <section className="helm-activity-section helm-no-run"><Icon name="activity" size={18} /><h3>No active run</h3><p>Run the deterministic demo to inspect Reason → Action → Observation → Verification.</p></section>}
      <VmCard onVmAction={props.onVmAction} screenshot={props.screenshot} vm={props.vm} vmAction={props.vmAction} />
      <HealthCard connectionState={props.connectionState} health={props.health} onRefreshDiagnostics={props.onRefreshDiagnostics} reconnectAttempt={props.reconnectAttempt} />
      <MemoryCard memories={props.memories} memoryActionId={props.memoryActionId} memoryLoading={props.memoryLoading} memoryQuery={props.memoryQuery} onAddMemory={props.onAddMemory} onDeleteMemory={props.onDeleteMemory} onMemoryQueryChange={props.onMemoryQueryChange} onSearchMemories={props.onSearchMemories} />
    </aside>
  );
}
