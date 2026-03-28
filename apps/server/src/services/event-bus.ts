import { EventEmitter } from 'node:events';
import type { RunEventRecord } from '../contracts.ts';

const runEventEmitter = new EventEmitter();
runEventEmitter.setMaxListeners(200);

const keyForRun = (runId: string) => `run:${runId}`;

export const emitRunEvent = (event: RunEventRecord): void => {
  runEventEmitter.emit(keyForRun(event.runId), event);
};

export const subscribeRunEvents = (
  runId: string,
  listener: (event: RunEventRecord) => void,
): (() => void) => {
  const key = keyForRun(runId);
  runEventEmitter.on(key, listener);

  return () => {
    runEventEmitter.off(key, listener);
  };
};
