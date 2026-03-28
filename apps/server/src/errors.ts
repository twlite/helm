export class ApiError extends Error {
  public readonly code: string;
  public readonly status: 400 | 404 | 409;

  public constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new ApiError(400, code, message);

export const notFound = (message: string, code = 'not_found') =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = 'conflict') =>
  new ApiError(409, code, message);
