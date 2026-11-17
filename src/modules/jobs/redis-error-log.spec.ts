import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import { describeRedisError, redisErrorLogger } from './redis-error-log.js';

describe('describeRedisError', () => {
  it('uses the message, then the code, then the first inner error', () => {
    expect(describeRedisError(new Error('boom'))).toBe('boom');
    expect(
      describeRedisError(
        Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('ECONNREFUSED');
    expect(
      describeRedisError(
        new AggregateError([new Error('connect ECONNREFUSED ::1:6380')], ''),
      ),
    ).toBe('connect ECONNREFUSED ::1:6380');
  });
});

describe('redisErrorLogger', () => {
  it('logs at most once every 30 s and counts what it skipped', () => {
    const warn = vi.fn();
    let t = 0;
    const log = redisErrorLogger(
      { warn } as unknown as Logger,
      'Redis queue error',
      () => t,
    );
    log(new Error('a'));
    t = 1_000;
    log(new Error('b'));
    log(new Error('c'));
    t = 31_000;
    log(new Error('d'));
    expect(warn.mock.calls).toEqual([
      ['Redis queue error: a'],
      ['Redis queue error: d (2 more since the last message)'],
    ]);
  });
});
