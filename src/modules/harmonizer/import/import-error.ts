import { HttpException } from '@nestjs/common';

/** The error body an import stores, the same one the API answers for a synchronous upload. */
export interface ImportErrorBody {
  statusCode: number;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

/** An import rejected because of its file or its fields, with the code the client shows. */
export class ImportError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly detail: { message: string; params?: Record<string, unknown> },
  ) {
    super(detail.message);
  }

  toBody(): ImportErrorBody {
    return {
      statusCode: this.statusCode,
      code: this.code,
      message: this.detail.message,
      ...(this.detail.params ? { params: this.detail.params } : {}),
    };
  }
}

/**
 * Body for any error thrown while importing: an `ImportError`, a Nest exception thrown by
 * shared code (same shape as `HttpExceptionFilter`), or `null` for an unexpected error.
 */
export function importErrorBody(err: unknown): ImportErrorBody | null {
  if (err instanceof ImportError) return err.toBody();
  if (err instanceof HttpException) {
    const response = err.getResponse() as {
      code?: string;
      message?: string;
      params?: Record<string, unknown>;
    };
    if (typeof response === 'object' && response.code && response.message) {
      return {
        statusCode: err.getStatus(),
        code: response.code,
        message: response.message,
        ...(response.params ? { params: response.params } : {}),
      };
    }
  }
  return null;
}
