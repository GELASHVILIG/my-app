/**
 * Base error for everything this project throws deliberately.
 *
 * Carries a stable machine-readable `code` so callers can branch on the kind of
 * failure without string-matching a message.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Best-effort description of an unknown thrown value, safe to put in a log line. */
export function describeError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof Error) {
    return { errorClass: error.name, message: error.message };
  }
  return { errorClass: typeof error, message: String(error) };
}
