export class DesktopServiceError extends Error {
  public constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DesktopServiceError';
    Error.captureStackTrace?.(this, DesktopServiceError);
  }
}
