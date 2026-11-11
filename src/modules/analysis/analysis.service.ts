import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describeDuckDbError } from './duckdb-error.js';
import { assertReadOnlySelect } from './sql-sanitizer.js';
import { buildRecipeSql, quoteIdent, type Recipe } from './recipe.js';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ColumnInfo {
  name: string;
  type: string;
}

/** Tipos que `writeRowsToParquet` sabe escribir. */
export type ParquetColumnType = 'VARCHAR' | 'BIGINT' | 'DOUBLE';

export interface NamedSource {
  alias: string;
  path: string;
}

const MAX_ROWS = 10_000;

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
}

const logger = new Logger('AnalysisService');

function safeDuckDbError(
  err: unknown,
  paths: string[],
  code = 'query_execution_failed',
): BadRequestException {
  let message = err instanceof Error ? err.message : 'Unknown DuckDB error.';
  for (const path of paths) {
    message = message.split(path).join('<file>');
  }
  logger.warn(`${code}: ${message}`);
  return new BadRequestException({ code, ...describeDuckDbError(message) });
}

/**
 * Options for every DuckDB this service opens (`memory_limit`, `threads`, `temp_directory`).
 * The API provides its `API_DUCKDB_*` settings (`ApiDuckDbModule`) and the worker its
 * `DUCKDB_*` ones (worker.module.ts). Without them (unit tests), DuckDB's defaults apply.
 */
export const ANALYSIS_DUCKDB_OPTIONS = Symbol('ANALYSIS_DUCKDB_OPTIONS');

@Injectable()
export class AnalysisService {
  constructor(
    @Optional()
    @Inject(ANALYSIS_DUCKDB_OPTIONS)
    private readonly duckdbOptions?: Record<string, string>,
  ) {}

  /**
   * A fresh in-memory DuckDB. With a `temp_directory`, it gets its own folder inside it: two
   * DuckDBs spilling to disk in the same folder at once overwrite each other's files ("Could
   * not read enough bytes from file …duckdb_temp_storage…"). `close` closes it and deletes
   * that folder.
   */
  private async openInstance(): Promise<{
    instance: DuckDBInstance;
    close(): Promise<void>;
  }> {
    const base = this.duckdbOptions?.temp_directory;
    if (!base) {
      const instance = await DuckDBInstance.create(':memory:', this.duckdbOptions);
      return { instance, close: () => Promise.resolve(instance.closeSync()) };
    }
    const tempDirectory = join(base, randomUUID());
    const instance = await DuckDBInstance.create(':memory:', {
      ...this.duckdbOptions,
      temp_directory: tempDirectory,
    });
    return {
      instance,
      close: async () => {
        try {
          instance.closeSync();
        } finally {
          await rm(tempDirectory, { recursive: true, force: true });
        }
      },
    };
  }

  private async withViews<T>(
    sources: NamedSource[],
    fn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    const duckdb = await this.openInstance();
    const connection = await duckdb.instance.connect();
    try {
      for (const source of sources) {
        await connection.run(
          `CREATE OR REPLACE TEMP VIEW ${quoteIdent(source.alias)} AS SELECT * FROM read_parquet('${escapeSqlLiteral(source.path)}')`,
        );
      }
      return await fn(connection);
    } finally {
      connection.closeSync();
      await duckdb.close();
    }
  }

  /** Column names of each view, so a join can skip the columns it would repeat. */
  private async columnsBySource(
    connection: DuckDBConnection,
    sources: NamedSource[],
  ): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const source of sources) {
      const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${quoteIdent(source.alias)}`);
      result[source.alias] = reader.getRowObjectsJson().map((row: any) => String(row.column_name));
    }
    return result;
  }

  private withDataView<T>(
    parquetPath: string,
    fn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    return this.withViews([{ alias: 'data', path: parquetPath }], fn);
  }

  async runQuery(parquetPath: string, sql: string): Promise<QueryResult> {
    assertReadOnlySelect(sql);
    try {
      return await this.withDataView(parquetPath, async (connection) => {
        const userSql = stripTrailingSemicolon(sql);
        const wrapped = `SELECT * FROM (${userSql}) AS _ibero_query LIMIT ${MAX_ROWS}`;
        const reader = await connection.runAndReadAll(wrapped);
        return {
          columns: reader.columnNames(),
          rows: reader.getRowObjectsJson() as Record<string, unknown>[],
        };
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw safeDuckDbError(err, [parquetPath]);
    }
  }

  /**
   * Runs SELECTs built by the server (never user SQL) over one Parquet, seen as the view `data`
   * with its columns plus `file_row_number` (the row's position in the file, from 0). All the
   * queries share one DuckDB. Returns the rows of each query, in order.
   */
  async runInternalQueries(
    parquetPath: string,
    queries: string[],
  ): Promise<unknown[][][]> {
    if (queries.length === 0) return [];
    const duckdb = await this.openInstance();
    const connection = await duckdb.instance.connect();
    try {
      await connection.run(
        `CREATE TEMP VIEW data AS SELECT * FROM read_parquet('${escapeSqlLiteral(parquetPath)}', file_row_number = true)`,
      );
      const out: unknown[][][] = [];
      for (const sql of queries) {
        out.push((await connection.runAndReadAll(sql)).getRowsJson() as unknown[][]);
      }
      return out;
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'parquet_read_failed');
    } finally {
      connection.closeSync();
      await duckdb.close();
    }
  }

  /**
   * Runs one SELECT built by the server over one Parquet (the view `data`, as in
   * `runInternalQueries`) and yields its rows chunk by chunk, in result order, so a large result
   * never sits in memory whole.
   */
  async *streamInternalRows(
    parquetPath: string,
    sql: string,
  ): AsyncGenerator<unknown[][]> {
    const duckdb = await this.openInstance();
    const connection = await duckdb.instance.connect();
    try {
      await connection.run(
        `CREATE TEMP VIEW data AS SELECT * FROM read_parquet('${escapeSqlLiteral(parquetPath)}', file_row_number = true)`,
      );
      const result = await connection.stream(sql);
      for await (const rows of result.yieldRowsJson()) {
        yield rows as unknown[][];
      }
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'parquet_read_failed');
    } finally {
      connection.closeSync();
      await duckdb.close();
    }
  }

  /**
   * Writes the rows of `parts` (SELECTs built by the server, all with the same columns), one
   * part after another, to a Parquet file. Each source is a view over one Parquet, with its
   * columns plus `file_row_number`. DuckDB streams the rows to the file, spilling to disk when
   * needed, so the result is never held in memory.
   *
   * A single SELECT keeps the order of its source, but `UNION ALL` does not keep the order of
   * its parts (it mixed a small edition into a large one). So, with several parts, each one is
   * written to its own file and the files are then read back in order, which DuckDB keeps.
   */
  async copyInternalQueryToParquet(
    sources: NamedSource[],
    parts: string[],
    destPath: string,
  ): Promise<void> {
    const duckdb = await this.openInstance();
    const connection = await duckdb.instance.connect();
    const partPaths =
      parts.length > 1 ? parts.map((_, i) => `${destPath}.part${i}.parquet`) : [];
    const copy = (sql: string, path: string) =>
      connection.run(`COPY (${sql}) TO '${escapeSqlLiteral(path)}' (FORMAT PARQUET)`);
    try {
      for (const source of sources) {
        await connection.run(
          `CREATE TEMP VIEW ${quoteIdent(source.alias)} AS SELECT * FROM read_parquet('${escapeSqlLiteral(source.path)}', file_row_number = true)`,
        );
      }
      if (parts.length === 1) {
        await copy(parts[0], destPath);
      } else {
        for (const [i, sql] of parts.entries()) await copy(sql, partPaths[i]);
        const list = partPaths.map((p) => `'${escapeSqlLiteral(p)}'`).join(', ');
        await copy(`SELECT * FROM read_parquet([${list}])`, destPath);
      }
    } catch (err) {
      throw safeDuckDbError(
        err,
        [...sources.map((s) => s.path), destPath, ...partPaths],
        'parquet_write_failed',
      );
    } finally {
      connection.closeSync();
      await duckdb.close();
      await Promise.all(partPaths.map((p) => rm(p, { force: true })));
    }
  }

  async describeSchema(parquetPath: string): Promise<ColumnInfo[]> {
    try {
      return await this.withDataView(parquetPath, async (connection) => {
        const reader = await connection.runAndReadAll(
          'DESCRIBE SELECT * FROM data',
        );
        return reader.getRowObjectsJson().map((row: any) => ({
          name: String(row.column_name),
          type: String(row.column_type),
        }));
      });
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'schema_read_failed');
    }
  }

  async runRecipe(
    parquetPath: string,
    recipe: Recipe,
    limit: number | null,
    joinSources: NamedSource[] = [],
  ): Promise<QueryResult> {
    const sources = [{ alias: 'data', path: parquetPath }, ...joinSources];
    try {
      return await this.withViews(sources, async (connection) => {
        const columns = joinSources.length > 0 ? await this.columnsBySource(connection, sources) : undefined;
        const { sql, params } = buildRecipeSql(recipe, limit, columns);
        const prepared = await connection.prepare(sql);
        params.forEach((value, i) => {
          const idx = i + 1;
          if (typeof value === 'number') {
            Number.isInteger(value)
              ? prepared.bindInteger(idx, value)
              : prepared.bindDouble(idx, value);
          } else {
            prepared.bindVarchar(idx, String(value));
          }
        });
        const reader = await prepared.runAndReadAll();
        return {
          columns: reader.columnNames(),
          rows: reader.getRowObjectsJson() as Record<string, unknown>[],
        };
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw safeDuckDbError(
        err,
        sources.map((s) => s.path),
        'recipe_execution_failed',
      );
    }
  }

  /**
   * Vuelca filas en memoria a un Parquet (lo usa el armonizador). Las columnas son
   * VARCHAR salvo las que `types` declara numéricas: esas se convierten con CAST
   * sobre el texto recortado, así que el llamador debe validar antes los valores.
   * `null`/`undefined` se escriben como NULL.
   */
  async writeRowsToParquet(
    columns: string[],
    rows: Record<string, unknown>[],
    destPath: string,
    types: Record<string, ParquetColumnType> = {},
  ): Promise<void> {
    if (columns.length === 0) {
      throw new BadRequestException({
        code: 'parquet_columns_required',
        message: 'Cannot write a Parquet file without columns.',
      });
    }
    const duckdb = await this.openInstance();
    const connection = await duckdb.instance.connect();
    try {
      const columnDefs = columns
        .map((c) => `${quoteIdent(c)} VARCHAR`)
        .join(', ');
      await connection.run(`CREATE TABLE _ibero_rows (${columnDefs})`);

      const appender = await connection.createAppender('_ibero_rows');
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          if (value === undefined || value === null) appender.appendNull();
          else appender.appendVarchar(String(value));
        }
        appender.endRow();
      }
      appender.closeSync();

      const selectList = columns
        .map((c) => {
          const type = types[c] ?? 'VARCHAR';
          const col = quoteIdent(c);
          return type === 'VARCHAR'
            ? col
            : `CAST(TRIM(${col}) AS ${type}) AS ${col}`;
        })
        .join(', ');
      await connection.run(
        `COPY (SELECT ${selectList} FROM _ibero_rows) TO '${escapeSqlLiteral(destPath)}' (FORMAT PARQUET)`,
      );
    } catch (err) {
      throw safeDuckDbError(err, [destPath], 'parquet_write_failed');
    } finally {
      connection.closeSync();
      await duckdb.close();
    }
  }

  /**
   * Lee un Parquet completo como filas posicionales, sin el tope de MAX_ROWS
   * (lo usa el armonizador para sus archivos crudos todo-VARCHAR).
   */
  async readParquetRows(parquetPath: string): Promise<unknown[][]> {
    try {
      return await this.withDataView(parquetPath, async (connection) => {
        const reader = await connection.runAndReadAll('SELECT * FROM data');
        return reader.getRowsJson() as unknown[][];
      });
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'parquet_read_failed');
    }
  }

  /**
   * Lee solo `limit` filas desde la `offset` (base 0), en el orden del archivo y solo
   * con las columnas pedidas (lo usa el armonizador para paginar sus vistas).
   * DuckDB conserva el orden de inserción por defecto, así que LIMIT/OFFSET sin
   * ORDER BY respeta el orden de las filas del Parquet.
   */
  async readParquetSlice(
    parquetPath: string,
    columns: string[],
    offset: number,
    limit: number,
  ): Promise<unknown[][]> {
    if (columns.length === 0 || limit <= 0) return [];
    const selectList = columns.map((c) => quoteIdent(c)).join(', ');
    const sql = `SELECT ${selectList} FROM data LIMIT ${Math.trunc(limit)} OFFSET ${Math.max(Math.trunc(offset), 0)}`;
    try {
      return await this.withDataView(parquetPath, async (connection) => {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowsJson() as unknown[][];
      });
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'parquet_read_failed');
    }
  }

  /**
   * Valores distintos de cada columna (recortados) con su frecuencia, del más frecuente al
   * menos y, en un empate, en orden alfabético. Devuelve como mucho `limit` valores por
   * columna y avisa con `capped` si hay más. Las celdas vacías no son valores: se cuentan en
   * `empty`. Lo usa el armonizador para comparar los códigos de una variable entre ediciones.
   */
  async columnValueCounts(
    parquetPath: string,
    columns: string[],
    limit: number,
  ): Promise<{ values: { value: string; count: number }[]; capped: boolean; empty: number }[]> {
    if (columns.length === 0) return [];
    const max = Math.max(Math.trunc(limit), 1);
    const trimmed = (c: string) => `coalesce(trim(${quoteIdent(c)}), '')`;
    try {
      return await this.withDataView(parquetPath, async (connection) => {
        const empties = (
          await connection.runAndReadAll(
            `SELECT ${columns.map((c) => `count(*) FILTER (WHERE ${trimmed(c)} = '')::INTEGER`).join(', ')} FROM data`,
          )
        ).getRowsJson()[0] as number[];
        const out = [];
        for (const [i, column] of columns.entries()) {
          const rows = (
            await connection.runAndReadAll(
              `SELECT v, count(*)::INTEGER AS n FROM (SELECT ${trimmed(column)} AS v FROM data) WHERE v <> '' GROUP BY v ORDER BY n DESC, v LIMIT ${max + 1}`,
            )
          ).getRowsJson() as [string, number][];
          out.push({
            values: rows.slice(0, max).map(([value, count]) => ({ value, count: Number(count) })),
            capped: rows.length > max,
            empty: Number(empties[i]),
          });
        }
        return out;
      });
    } catch (err) {
      throw safeDuckDbError(err, [parquetPath], 'parquet_read_failed');
    }
  }

  async writeRecipeResult(
    parquetPath: string,
    recipe: Recipe,
    destPath: string,
    joinSources: NamedSource[] = [],
  ): Promise<void> {
    const sources = [{ alias: 'data', path: parquetPath }, ...joinSources];
    try {
      await this.withViews(sources, async (connection) => {
        const columns = joinSources.length > 0 ? await this.columnsBySource(connection, sources) : undefined;
        const { sql, params } = buildRecipeSql(recipe, null, columns);
        const prepared = await connection.prepare(
          `COPY (${sql}) TO '${escapeSqlLiteral(destPath)}' (FORMAT PARQUET)`,
        );
        params.forEach((value, i) => {
          const idx = i + 1;
          if (typeof value === 'number') {
            Number.isInteger(value)
              ? prepared.bindInteger(idx, value)
              : prepared.bindDouble(idx, value);
          } else {
            prepared.bindVarchar(idx, String(value));
          }
        });
        await prepared.run();
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw safeDuckDbError(
        err,
        sources.map((s) => s.path),
        'recipe_execution_failed',
      );
    }
  }
}
