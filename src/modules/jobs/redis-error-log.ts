import type { Logger } from '@nestjs/common';

const QUIET_MS = 30_000;

/**
 * Text for a Redis connection error. A refused connection arrives as an AggregateError with
 * an empty `message`, so fall back to its code or to its first inner error.
 */
export function describeRedisError(err: Error): string {
  const e = err as Error & { code?: string; errors?: unknown[] };
  const inner = e.errors?.[0];
  return (
    err.message ||
    e.code ||
    (inner instanceof Error ? inner.message : '') ||
    err.name ||
    'unknown error'
  );
}

/**
 * Logs Redis errors at most once every 30 s. While Redis is down, ioredis reports every
 * reconnection attempt, which would flood the log.
 */
export function redisErrorLogger(
  logger: Logger,
  what: string,
  now = () => Date.now(),
) {
  let last = -Infinity;
  let suppressed = 0;
  return (err: Error): void => {
    const t = now();
    if (t - last < QUIET_MS) {
      suppressed++;
      return;
    }
    const more =
      suppressed > 0 ? ` (${suppressed} more since the last message)` : '';
    logger.warn(`${what}: ${describeRedisError(err)}${more}`);
    last = t;
    suppressed = 0;
  };
}
