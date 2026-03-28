interface RunControl {
  controller: AbortController;
  requested: boolean;
  reason: string;
}

const runControls = new Map<string, RunControl>();

const ensureControl = (runId: string): RunControl => {
  const existing = runControls.get(runId);
  if (existing) {
    return existing;
  }

  const created: RunControl = {
    controller: new AbortController(),
    requested: false,
    reason: 'Cancelled by user.',
  };

  runControls.set(runId, created);
  return created;
};

export const acquireRunAbortSignal = (runId: string): AbortSignal => {
  const control = ensureControl(runId);

  if (control.requested && !control.controller.signal.aborted) {
    control.controller.abort(control.reason);
  }

  return control.controller.signal;
};

export const requestRunCancellation = (
  runId: string,
  reason = 'Cancelled by user.',
): void => {
  const control = ensureControl(runId);
  control.requested = true;
  control.reason = reason;

  if (!control.controller.signal.aborted) {
    control.controller.abort(reason);
  }
};

export const isRunCancellationRequested = (runId: string): boolean => {
  const control = runControls.get(runId);
  return control?.requested ?? false;
};

export const releaseRunControl = (runId: string): void => {
  runControls.delete(runId);
};
