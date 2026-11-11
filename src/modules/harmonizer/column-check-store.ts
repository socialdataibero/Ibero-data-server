import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AnalysisService } from '../analysis/analysis.service.js';

/**
 * Runs single-row column checks (`columnTypeQuery`) over an edition's raw Parquet, keeping each
 * result in `HarmonizerColumnCheck`: an edition's data never changes, so a check with the same
 * query gives the same row forever. On the census, the identifier columns (15 million distinct
 * values) take seconds; with this they are computed once. Used by the API (mapping) and by the
 * worker (right after an import). Returns the row of each query, in order.
 */
export async function cachedColumnChecks(
  prisma: PrismaService,
  analysis: AnalysisService,
  datasetId: string,
  parquetPath: string,
  queries: string[],
): Promise<unknown[][]> {
  if (queries.length === 0) return [];
  const keys = queries.map((q) => createHash('sha256').update(q).digest('hex'));
  const stored = await prisma.harmonizerColumnCheck.findMany({
    where: { datasetId, key: { in: [...new Set(keys)] } },
    select: { key: true, result: true },
  });
  const byKey = new Map(stored.map((s) => [s.key, s.result as unknown[]]));

  const missing = new Map<string, string>();
  keys.forEach((key, i) => {
    if (!byKey.has(key)) missing.set(key, queries[i]);
  });
  if (missing.size > 0) {
    const rows = await analysis.runInternalQueries(parquetPath, [...missing.values()]);
    const computed = [...missing.keys()].map((key, i) => ({ key, result: rows[i][0] }));
    // Two requests can compute the same check at once: the first one stays.
    await prisma.harmonizerColumnCheck.createMany({
      data: computed.map(({ key, result }) => ({
        datasetId,
        key,
        result: result as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    for (const { key, result } of computed) byKey.set(key, result);
  }
  return keys.map((key) => byKey.get(key)!);
}
