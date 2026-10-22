export class ApiError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export function requireValue(condition, status = 400, code = 'INVALID_REQUEST') {
  if (!condition) throw new ApiError(status, code);
}
