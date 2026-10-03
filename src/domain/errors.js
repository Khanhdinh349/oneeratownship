'use strict';

/**
 * Domain error carrying an HTTP status, a stable machine code and optional
 * per-field details so the UI can render validation state (§Step 7 UI States).
 */
class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'Not permitted') => new AppError(403, 'FORBIDDEN', message);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message, details) => new AppError(409, code, message, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
