import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);

export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}

export function parse<T>(schema: ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('Validation failed', formatZod(result.error));
  }
  return result.data;
}

function formatZod(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: 'Validation failed', details: formatZod(err) },
    });
    return;
  }
  const maybe = err as { code?: string; type?: string; message?: string };
  if (maybe?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'file_too_large', message: 'Uploaded file is too large' } });
    return;
  }
  if (maybe?.code === '23505') {
    res.status(409).json({ error: { code: 'conflict', message: 'That record already exists' } });
    return;
  }
  console.error('[api] unhandled error', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
  });
}
