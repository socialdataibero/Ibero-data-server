import { BadRequestException, Injectable } from '@nestjs/common';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
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

function safeDuckDbError(
  err: unknown,
  paths: string[],
  code = 'query_execution_failed',
): BadRequestException {
  let message = err instanceof Error ? err.message : 'Unknown DuckDB error.';
  for (const path of paths) {
    message = message.split(path).join('<file>');
  }
  return new BadRequestException({ code, message });
}

@Injectable()
export class AnalysisService {
  private async withViews<T>(
    sources: NamedSource[],
    fn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      for (const source of sources) {
        await connection.run(
          `CREATE OR REPLACE TEMP VIEW ${quoteIdent(source.alias)} AS SELECT * FROM read_parquet('${escapeSqlLiteral(source.path)}')`,
        );
      }
      return await fn(connection);
    } finally {
      connection.closeSync();
    }
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
    const { sql, params } = buildRecipeSql(recipe, limit);
    const sources = [{ alias: 'data', path: parquetPath }, ...joinSources];
    try {
      return await this.withViews(sources, async (connection) => {
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
      throw safeDuckDbError(
        err,
        sources.map((s) => s.path),
        'recipe_execution_failed',
      );
    }
  }

  /**
   * Vuelca filas en memoria a un Parquet todo-VARCHAR (lo usa el armonizador:
   * su pipeline es todo-string y no infiere tipos). Las celdas ausentes salen
   * como "" y no como NULL, igual que el `fillna("")` del original.
   */
  async writeRowsToParquet(
    columns: string[],
    rows: Record<string, unknown>[],
    destPath: string,
  ): Promise<void> {
    if (columns.length === 0) {
      throw new BadRequestException({
        code: 'parquet_columns_required',
        message: 'Cannot write a Parquet file without columns.',
      });
    }
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
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

      await connection.run(
        `COPY _ibero_rows TO '${escapeSqlLiteral(destPath)}' (FORMAT PARQUET)`,
      );
    } catch (err) {
      throw safeDuckDbError(err, [destPath], 'parquet_write_failed');
    } finally {
      connection.closeSync();
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

  async writeRecipeResult(
    parquetPath: string,
    recipe: Recipe,
    destPath: string,
    joinSources: NamedSource[] = [],
  ): Promise<void> {
    const { sql, params } = buildRecipeSql(recipe, null);
    const sources = [{ alias: 'data', path: parquetPath }, ...joinSources];
    try {
      await this.withViews(sources, async (connection) => {
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
      throw safeDuckDbError(
        err,
        sources.map((s) => s.path),
        'recipe_execution_failed',
      );
    }
  }
}
