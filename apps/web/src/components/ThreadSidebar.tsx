import { useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import type { Thread } from '../types';
import { formatDate } from '../format';
import { Icon } from './Icon';

type ThreadSidebarProps = {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (title: string) => Promise<boolean>;
  onDeleteThread: (threadId: string) => Promise<void>;
  isCreating: boolean;
};

export function ThreadSidebar({
  threads,
  selectedThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  isCreating,
}: ThreadSidebarProps) {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [title, setTitle] = useState('');

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || isCreating) {
      return;
    }
    const created = await onCreateThread(nextTitle);
    if (created) {
      setTitle('');
      setIsComposerOpen(false);
    }
  }

  async function handleDelete(event: MouseEvent<HTMLElement>, threadId: string) {
    event.stopPropagation();
    await onDeleteThread(threadId);
  }

  return (
    <aside className="helm-threads-panel" aria-label="Threads">
      <div className="helm-brand-block">
        <div className="helm-brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="helm-eyebrow">Local agent harness</p>
          <h1>Helm</h1>
        </div>
      </div>

      <div className="helm-panel-heading">
        <div>
          <p className="helm-section-label">Workspace</p>
          <h2>Threads</h2>
        </div>
        <span className="helm-count-badge">{threads.length}</span>
      </div>

      <div className="helm-thread-list">
        {threads.length > 0 ? (
          threads.map((thread) => (
            <button
              className={`helm-thread-row${thread.id === selectedThreadId ? ' is-selected' : ''}`}
              key={thread.id}
              onClick={() => onSelectThread(thread.id)}
              type="button"
            >
              <span className="helm-thread-icon">
                <Icon name="message" size={15} />
              </span>
              <span className="helm-thread-copy">
                <strong>{thread.title}</strong>
                <small>{formatDate(thread.updatedAt)}</small>
              </span>
              <span
                aria-label={`Delete ${thread.title}`}
                className="helm-icon-button helm-thread-delete"
                onClick={(event) => void handleDelete(event, thread.id)}
                role="button"
                tabIndex={0}
              >
                <Icon name="trash" size={14} />
              </span>
            </button>
          ))
        ) : (
          <div className="helm-empty-state helm-empty-threads">
            <Icon name="message" size={20} />
            <p>No threads yet.</p>
            <span>Create a thread to start saving work.</span>
          </div>
        )}
      </div>

      <div className="helm-thread-create">
        {isComposerOpen ? (
          <form className="helm-create-form" onSubmit={(event) => void handleCreate(event)}>
            <label className="helm-sr-only" htmlFor="new-thread-title">
              Thread title
            </label>
            <input
              autoFocus
              id="new-thread-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Name this thread"
              value={title}
            />
            <div className="helm-form-actions">
              <button
                className="helm-button helm-button-primary helm-button-small"
                disabled={!title.trim() || isCreating}
                type="submit"
              >
                {isCreating ? 'Creating…' : 'Create'}
              </button>
              <button
                className="helm-button helm-button-quiet helm-button-small"
                onClick={() => {
                  setTitle('');
                  setIsComposerOpen(false);
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            className="helm-new-thread-button"
            onClick={() => setIsComposerOpen(true)}
            type="button"
          >
            <span className="helm-new-thread-icon">
              <Icon name="plus" size={15} />
            </span>
            New thread
            <span className="helm-key-hint">N</span>
          </button>
        )}
      </div>

      <div className="helm-sidebar-footer">
        <span className="helm-status-dot is-live" />
        <span>Local workspace</span>
        <span className="helm-footer-version">v0.1</span>
      </div>
    </aside>
  );
}
