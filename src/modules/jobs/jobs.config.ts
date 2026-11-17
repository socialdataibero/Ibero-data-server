/**
 * Settings shared by the API (which adds jobs) and the worker process (which runs them).
 * Read from the environment, with defaults for local development.
 */

/** Host port of the Redis in docker-compose.yml (6380, so it does not clash with a local 6379). */
export const DEFAULT_REDIS_URL = 'redis://localhost:6380';
export const DEFAULT_WORKER_CONCURRENCY = 1;

/**
 * One queue for every background job, so `WORKER_CONCURRENCY` bounds how many heavy DuckDB
 * jobs run at once in a worker process, whatever their kind.
 */
export const JOBS_QUEUE = 'ibero-jobs';

export class JobsConfigError extends Error {}

export function redisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.REDIS_URL?.trim();
  if (!raw) return DEFAULT_REDIS_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JobsConfigError(`REDIS_URL is not a valid URL: "${raw}".`);
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new JobsConfigError(
      `REDIS_URL must start with redis:// or rediss://, got "${raw}".`,
    );
  }
  return raw;
}

export function workerConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.WORKER_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_WORKER_CONCURRENCY;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new JobsConfigError(
      `WORKER_CONCURRENCY must be a positive integer, got "${raw}".`,
    );
  }
  return value;
}

/** The URL without its password, for logs. */
export function safeRedisUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid REDIS_URL>';
  }
}

/**
 * BullMQ connection options. `maxRetriesPerRequest: null` is what BullMQ requires for workers
 * (blocking commands must wait for Redis to come back instead of failing).
 */
export function redisConnection(env: NodeJS.ProcessEnv = process.env) {
  return { url: redisUrl(env), maxRetriesPerRequest: null };
}
