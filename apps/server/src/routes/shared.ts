import { badRequest } from '../errors.ts';

export const doneEventTypes = new Set([
  'run_completed',
  'run_failed',
  'run_cancelled',
]);

export const safeJsonBody = async (request: Request): Promise<unknown> => {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
};
