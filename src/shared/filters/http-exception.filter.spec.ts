import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter.js';

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
});
