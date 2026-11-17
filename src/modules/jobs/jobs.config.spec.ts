import { describe, expect, it } from 'vitest';
import {
  JobsConfigError,
  redisConnection,
  redisUrl,
  safeRedisUrl,
  workerConcurrency,
} from './jobs.config.js';

describe('redisUrl', () => {
  it('defaults to the docker-compose Redis on host port 6380', () => {
    expect(redisUrl({})).toBe('redis://localhost:6380');
    expect(redisUrl({ REDIS_URL: '  ' })).toBe('redis://localhost:6380');
  });

  it('accepts redis:// and rediss:// URLs', () => {
    expect(redisUrl({ REDIS_URL: 'redis://cache:6379/2' })).toBe(
      'redis://cache:6379/2',
    );
    expect(redisUrl({ REDIS_URL: 'rediss://user:pw@cache:6380' })).toBe(
      'rediss://user:pw@cache:6380',
    );
  });

  it('rejects other values', () => {
    expect(() => redisUrl({ REDIS_URL: 'localhost:6379' })).toThrow(
      JobsConfigError,
    );
    expect(() => redisUrl({ REDIS_URL: 'http://localhost:6379' })).toThrow(
      JobsConfigError,
    );
    expect(() => redisUrl({ REDIS_URL: 'not a url' })).toThrow(JobsConfigError);
  });
});

describe('workerConcurrency', () => {
  it('defaults to 1', () => {
    expect(workerConcurrency({})).toBe(1);
  });

  it('reads WORKER_CONCURRENCY', () => {
    expect(workerConcurrency({ WORKER_CONCURRENCY: '3' })).toBe(3);
  });

  it('rejects values that are not a positive integer', () => {
    for (const value of ['0', '-1', '1.5', 'two', '1e2']) {
      expect(() => workerConcurrency({ WORKER_CONCURRENCY: value })).toThrow(
        JobsConfigError,
      );
    }
  });
});

describe('safeRedisUrl', () => {
  it('hides the password', () => {
    expect(safeRedisUrl('redis://user:secret@cache:6379')).toBe(
      'redis://user:***@cache:6379',
    );
    expect(safeRedisUrl('redis://localhost:6380')).toBe(
      'redis://localhost:6380',
    );
  });
});

describe('redisConnection', () => {
  it('lets blocking commands wait for Redis, as BullMQ workers require', () => {
    expect(redisConnection({})).toEqual({
      url: 'redis://localhost:6380',
      maxRetriesPerRequest: null,
    });
  });
});
