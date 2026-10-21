import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter.js';

function recordNotFound(modelName?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
    code: 'P2025',
    clientVersion: 'test',
    meta: modelName ? { modelName } : undefined,
  });
}

function capture(exception: unknown): unknown {
  let sent: unknown;
  const response = { status: () => ({ json: (body: unknown) => (sent = body) }) };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return sent;
}

describe('HttpExceptionFilter', () => {
  it('forwards reason and params so clients can explain the error', () => {
    const body = capture(
      new BadRequestException({
        code: 'recipe_execution_failed',
        message: 'The value "abc" is not a valid integer for this column.',
        reason: 'invalid_value',
        params: { value: 'abc', expectedType: 'integer' },
      }),
    );

    expect(body).toEqual({
      statusCode: 400,
      code: 'recipe_execution_failed',
      message: 'The value "abc" is not a valid integer for this column.',
      reason: 'invalid_value',
      params: { value: 'abc', expectedType: 'integer' },
    });
  });

  it('leaves reason and params out when the exception has none', () => {
    expect(capture(new BadRequestException({ code: 'analysis_slug_taken', message: 'Slug taken.' }))).toEqual({
      statusCode: 400,
      code: 'analysis_slug_taken',
      message: 'Slug taken.',
    });
  });

  it("answers 404 with the model's not-found code when a write finds no record (P2025)", () => {
    expect(capture(recordNotFound('HarmonizerDataset'))).toEqual({
      statusCode: 404,
      code: 'harmonizer_dataset_not_found',
      message: 'The record no longer exists. Another request may have deleted it at the same time.',
    });
  });

  it('falls back to not_found for a P2025 on a model without its own code', () => {
    expect(capture(recordNotFound())).toMatchObject({ statusCode: 404, code: 'not_found' });
  });
});
