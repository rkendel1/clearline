// Typed application errors mapped to HTTP responses by the API layer.

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthenticated', msg);
export const forbidden = (code: string, msg: string) => new AppError(403, code, msg);
export const notFound = (msg: string) => new AppError(404, 'not_found', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
