import type { ConversationRecord } from '@/lib/api';

export const getText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

export const partText = (part: {
  content: Record<string, unknown>;
}): string => {
  if (typeof part.content.text === 'string') {
    return part.content.text;
  }

  return prettyJson(part.content);
};

export const formatStatus = (status: string): string => {
  if (status === 'queued') {
    return 'Queued';
  }
  if (status === 'running') {
    return 'Running';
  }
  if (status === 'completed') {
    return 'Completed';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  if (status === 'cancelled') {
    return 'Cancelled';
  }
  return status;
};

export const buildVncUrl = (): string => {
  const rawBase =
    import.meta.env.VITE_VNC_EMBED_URL ?? 'http://localhost:6080/vnc.html';

  try {
    const url = new URL(rawBase, window.location.origin);

    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/vnc.html';
    }

    if (!url.searchParams.has('host') && url.hostname) {
      url.searchParams.set('host', url.hostname);
    }
    if (!url.searchParams.has('port') && url.port) {
      url.searchParams.set('port', url.port);
    }
    if (!url.searchParams.has('path')) {
      url.searchParams.set('path', 'websockify');
    }

    if (!url.searchParams.has('autoconnect')) {
      url.searchParams.set('autoconnect', 'true');
    }
    if (!url.searchParams.has('reconnect')) {
      url.searchParams.set('reconnect', 'true');
    }
    if (!url.searchParams.has('resize')) {
      url.searchParams.set('resize', 'scale');
    }

    return url.toString();
  } catch {
    const separator = rawBase.includes('?') ? '&' : '?';
    return `${rawBase}${separator}autoconnect=true&reconnect=true&resize=scale&path=websockify`;
  }
};

export const buildConversationTitle = (
  conversation: ConversationRecord,
): string => {
  if (conversation.title.trim()) {
    return conversation.title;
  }

  if (conversation.lastPreview?.trim()) {
    return conversation.lastPreview.slice(0, 70);
  }

  return 'New task';
};
