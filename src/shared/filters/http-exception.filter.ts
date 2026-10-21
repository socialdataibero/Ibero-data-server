import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

interface ExceptionBody {
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  params?: unknown;
}

const DEFAULT_CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessable_entity',
  [HttpStatus.BAD_GATEWAY]: 'bad_gateway',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'internal_error',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let code = DEFAULT_CODE_BY_STATUS[status] ?? 'error';
    let message = 'An unexpected error occurred.';
    let details: string[] | undefined;
    let reason: string | undefined;
    let params: object | undefined;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const { code: bodyCode, message: bodyMessage, reason: bodyReason, params: bodyParams } = body as ExceptionBody;
        if (Array.isArray(bodyMessage)) {
          code = 'validation_error';
          details = bodyMessage as string[];
          message = details[0] ?? message;
        } else {
          if (typeof bodyMessage === 'string') message = bodyMessage;
          if (typeof bodyCode === 'string') code = bodyCode;
          if (typeof bodyReason === 'string') reason = bodyReason;
          if (bodyParams && typeof bodyParams === 'object') params = bodyParams;
        }
      }
    } else {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : exception);
    }

    response.status(status).json({
      statusCode: status,
      code,
      message,
      ...(details ? { details } : {}),
      ...(reason ? { reason } : {}),
      ...(params ? { params } : {}),
    });
  }
}
