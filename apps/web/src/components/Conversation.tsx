import { memo } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { Message, Thread } from '../types';
import { formatTime } from '../format';
import { Icon } from './Icon';

type ConversationProps = {
  thread: Thread | null;
  messages: Message[];
  isLoading: boolean;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: (content: string) => Promise<void>;
  onRunDemo: () => Promise<void>;
  isRunStarting: boolean;
};

function roleLabel(role: Message['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Helm';
    case 'tool':
      return 'Tool';
    case 'system':
      return 'System';
  }
}

const MessageBubble = memo(function MessageBubble({ message }: { message: Message }) {
  return (
    <article className={`helm-message helm-message-${message.role}`}>
      <div className="helm-message-meta">
        <span className="helm-message-avatar">
          {message.role === 'user' ? 'Y' : message.role === 'assistant' ? <Icon name="spark" size={14} /> : <Icon name="activity" size={14} />}
        </span>
        <span>{roleLabel(message.role)}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      <div className="helm-message-content">{message.content}</div>
    </article>
  );
});

export function Conversation({
  thread,
  messages,
  isLoading,
  draft,
  isSending,
  onDraftChange,
  onSend,
  onRunDemo,
  isRunStarting,
}: ConversationProps) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSending || !thread) {
      return;
    }
    await onSend(content);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className="helm-conversation-panel">
      <header className="helm-conversation-header">
        <div>
          <p className="helm-section-label">Conversation</p>
          <h2>{thread?.title ?? 'Select a thread'}</h2>
        </div>
        <div className="helm-header-actions">
          <span className="helm-model-pill">
            <span className="helm-model-dot" />
            No model configured
          </span>
          <button
            className="helm-button helm-button-demo"
            disabled={!thread || isRunStarting}
            onClick={() => void onRunDemo()}
            type="button"
          >
            <Icon name="play" size={14} />
            {isRunStarting ? 'Starting demo…' : 'Run scripted demo'}
          </button>
        </div>
      </header>

      <div className="helm-conversation-body">
        {!thread ? (
          <div className="helm-conversation-empty">
            <div className="helm-empty-orbit">
              <Icon name="message" size={26} />
            </div>
            <h3>Your workspace is ready</h3>
            <p>Create a thread on the left to save messages and launch a deterministic demo.</p>
          </div>
        ) : (
          <>
            <div className="helm-model-notice">
              <span className="helm-notice-icon">
                <Icon name="flask" size={16} />
              </span>
              <span>
                <strong>Model boundary is inactive.</strong> Your messages are persisted, but Helm will not invent an assistant response until a model is configured.
              </span>
            </div>
            <div className="helm-message-list" aria-live="polite">
              {isLoading ? (
                <div className="helm-loading-row">
                  <span className="helm-spinner" /> Loading messages…
                </div>
              ) : messages.length > 0 ? (
                messages.map((message) => <MessageBubble key={message.id} message={message} />)
              ) : (
                <div className="helm-empty-state helm-empty-messages">
                  <Icon name="spark" size={19} />
                  <p>No messages in this thread.</p>
                  <span>Send an instruction, or use the scripted demo to exercise the runtime.</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <form className="helm-composer" onSubmit={(event) => void handleSubmit(event)}>
        <div className="helm-composer-shell">
          <label className="helm-sr-only" htmlFor="message-composer">
            Message
          </label>
          <textarea
            disabled={!thread || isSending}
            id="message-composer"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={thread ? 'Write a message to save to this thread…' : 'Create a thread to begin…'}
            rows={2}
            value={draft}
          />
          <div className="helm-composer-footer">
            <span>⌘ ↵ to send</span>
            <button
              aria-label="Save message"
              className="helm-send-button"
              disabled={!thread || !draft.trim() || isSending}
              type="submit"
            >
              {isSending ? <span className="helm-spinner helm-spinner-dark" /> : <Icon name="arrow-up" size={17} />}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
