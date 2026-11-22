import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnalysisService } from '../../analysis/analysis.service.js';
import { jsTrimSql } from '../column-checks.js';
import type { ColumnProfile } from '../comparison.js';
import { EditionFilesService } from '../editions/edition-files.service.js';

/** Distinct values kept per column in its profile. */
export const PROFILE_MAX_VALUES = 200;

/**
 * Value profiles of the columns of an edition: read from the database, or computed from the
 * stored file and saved the first time. The API and the worker (at the end of an import) use it.
 */
@Injectable()
export class ColumnProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly files: EditionFilesService,
  ) {}

  /**
   * Perfil de valores (valores distintos con su frecuencia) de las columnas pedidas, por
   * edición y columna. `column: null` pide todas las de la edición. Lo que no esté guardado
   * se calcula con DuckDB sobre el Parquet y se guarda: los datos de una edición no cambian.
   */
  async columnProfiles(
    wanted: {
      dataset: { id: string; columns: string[] };
      column: string | null;
    }[],
  ): Promise<Map<string, Map<string, ColumnProfile>>> {
    const columnsByDataset = new Map<
      string,
      { columns: string[]; wanted: Set<string> }
    >();
    for (const { dataset, column } of wanted) {
      const entry = columnsByDataset.get(dataset.id) ?? {
        columns: dataset.columns,
        wanted: new Set<string>(),
      };
      for (const c of column === null ? dataset.columns : [column]) {
        if (dataset.columns.includes(c)) entry.wanted.add(c);
      }
      columnsByDataset.set(dataset.id, entry);
    }
    const out = new Map<string, Map<string, ColumnProfile>>();
    if (columnsByDataset.size === 0) return out;

    const stored = await this.prisma.harmonizerColumnProfile.findMany({
      where: {
        datasetId: { in: [...columnsByDataset.keys()] },
        sourceColumn: {
          in: [
            ...new Set(
              [...columnsByDataset.values()].flatMap((e) => [...e.wanted]),
            ),
          ],
        },
      },
    });
    for (const p of stored) {
      if (!columnsByDataset.get(p.datasetId)?.wanted.has(p.sourceColumn))
        continue;
      const byColumn = out.get(p.datasetId) ?? new Map<string, ColumnProfile>();
      byColumn.set(p.sourceColumn, {
        values: p.values as unknown as ColumnProfile['values'],
        distinctCapped: p.distinctCapped,
        empty: p.empty,
      });
      out.set(p.datasetId, byColumn);
    }

    for (const [
      datasetId,
      { columns, wanted: wantedColumns },
    ] of columnsByDataset) {
      const byColumn = out.get(datasetId) ?? new Map<string, ColumnProfile>();
      out.set(datasetId, byColumn);
      const missing = [...wantedColumns].filter((c) => !byColumn.has(c));
      if (missing.length === 0) continue;
      const counts = await this.analysisService.columnValueCounts(
        await this.files.rawPath({ id: datasetId }),
        missing.map((c) => `c${columns.indexOf(c)}`),
        PROFILE_MAX_VALUES,
        jsTrimSql,
      );
      const rows = missing.map((column, i) => ({
        datasetId,
        sourceColumn: column,
        values: counts[i].values,
        distinctCapped: counts[i].capped,
        empty: counts[i].empty,
      }));
      // Dos peticiones a la vez pueden calcular el mismo perfil: gana la primera.
      await this.prisma.harmonizerColumnProfile.createMany({
        data: rows,
        skipDuplicates: true,
      });
      for (const row of rows) {
        byColumn.set(row.sourceColumn, {
          values: row.values,
          distinctCapped: row.distinctCapped,
          empty: row.empty,
        });
      }
    }
    return out;
  }
}
