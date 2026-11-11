import type { z } from 'zod';

/** An error whose code and message are safe to show to clients. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function parse<S extends z.ZodType>(schema: S, value: unknown, code = 'invalid_request', status = 422): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new ApiError(status, code, `${where}${issue?.message ?? 'invalid input'}`);
}
