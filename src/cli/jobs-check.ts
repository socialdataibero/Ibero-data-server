import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JobsModule } from '../modules/jobs/jobs.module.js';
import { JobsService } from '../modules/jobs/jobs.service.js';
import { redisUrl, safeRedisUrl } from '../modules/jobs/jobs.config.js';

/**
 * `npm run jobs:check`: adds a `diagnostic` job and waits for a worker to run it. Shows that
 * Redis answers, that a worker process is connected (with a pid other than this one) and the
 * DuckDB settings the worker applied. Exits with 1 if the job does not finish in time.
 */
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JobsModule] })
class JobsCheckModule {}

const TIMEOUT_MS = Number(process.env.JOBS_CHECK_TIMEOUT_MS ?? 30_000);
const logger = new Logger('jobs:check');

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(JobsCheckModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const jobs = app.get(JobsService);
    logger.log(
      `Redis ${safeRedisUrl(redisUrl())}, this process pid ${process.pid}`,
    );
    const workers = await jobs.workerCount();
    logger.log(`Connected workers: ${workers}`);
    if (workers === 0) {
      logger.warn(
        'No worker is connected. Start one with `npm run start:worker`; the job will wait for it.',
      );
    }

    const id = await jobs.add('diagnostic', {
      requestedBy: `jobs:check pid ${process.pid}`,
    });
    logger.log(
      `Added job diagnostic ${id}; waiting up to ${TIMEOUT_MS / 1000} s`,
    );
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const status = await jobs.status(id);
      if (status?.state === 'completed') {
        console.log(JSON.stringify(status, null, 2));
        const workerPid = (status.result as { pid?: number } | null)?.pid;
        logger.log(
          workerPid !== process.pid
            ? `OK: ran in worker pid ${workerPid}, a separate process.`
            : 'Unexpected: the job ran in this same process.',
        );
        return workerPid !== process.pid ? 0 : 1;
      }
      if (status?.state === 'failed') {
        console.log(JSON.stringify(status, null, 2));
        logger.error(`Job failed: ${status.failedReason}`);
        return 1;
      }
      if (Date.now() > deadline) {
        logger.error(
          `Timed out; the job is still "${status?.state ?? 'missing'}".`,
        );
        return 1;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await app.close();
  }
}

process.exitCode = await main();
