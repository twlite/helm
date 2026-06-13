export interface RunSteeringMessage {
  createdAt: string;
  text: string;
}

const runSteeringMessages = new Map<string, RunSteeringMessage[]>();

export const addRunSteeringMessage = (args: {
  runId: string;
  text: string;
}): RunSteeringMessage => {
  const message = {
    createdAt: new Date().toISOString(),
    text: args.text.trim(),
  };

  const existing = runSteeringMessages.get(args.runId) ?? [];
  runSteeringMessages.set(args.runId, [...existing, message]);
  return message;
};

export const buildRunSteeringContext = (runId: string): string | null => {
  const messages = runSteeringMessages.get(runId) ?? [];
  const relevant = messages.filter((message) => message.text);
  if (relevant.length === 0) {
    return null;
  }

  return [
    'Live user steering for this active run:',
    ...relevant.map((message, index) => `${index + 1}. ${message.text}`),
    'Treat these as high priority continuation instructions. Do not wait for a new run if you can satisfy them in the current next action.',
  ].join('\n');
};

export const clearRunSteeringMessages = (runId: string): void => {
  runSteeringMessages.delete(runId);
};
