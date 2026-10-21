import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

// Prisma's P2025 ("record to update/delete does not exist") happens when two requests race
// on the same row: the record existed when the service checked it and was gone by the
// write. It is answered with the same 404 the service gives when the record is missing.
const NOT_FOUND_CODE_BY_MODEL: Record<string, string> = {
  Organization: 'organization_not_found',
  Dataset: 'dataset_not_found',
  Resource: 'resource_not_found',
  Analysis: 'analysis_not_found',
  HarmonizerSurvey: 'survey_not_found',
  HarmonizerDataset: 'harmonizer_dataset_not_found',
  HarmonizerCanonicalVariable: 'canonical_variable_not_found',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      const model = typeof exception.meta?.modelName === 'string' ? exception.meta.modelName : '';
      this.logger.warn(`Record not found on write (${model || 'unknown model'}): ${exception.message}`);
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        code: NOT_FOUND_CODE_BY_MODEL[model] ?? 'not_found',
        message: 'The record no longer exists. Another request may have deleted it at the same time.',
      });
      return;
    }

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
