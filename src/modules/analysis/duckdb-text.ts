import { Logger } from '@nestjs/common';
import { createRequire } from 'node:module';

/**
 * Keeps a U+FEFF (BOM) at the start of the text that DuckDB hands to JavaScript.
 *
 * `@duckdb/node-api` decodes every VARCHAR (values and column names) with one shared
 * `new TextDecoder()`, whose default removes a leading BOM: DuckDB has `'\ufeff1'`, JavaScript
 * gets `"1"`, so a `GROUP BY` returns two `"1"` and a column `"\ufeffID"` reads as `ID`. The
 * library reads `exports.textDecoder` on every call, so replacing it with a decoder that keeps
 * the BOM is enough. Checked up to 2.0.0-r.1; `duckdb-text.spec.ts` fails if an upgrade breaks it.
 *
 * Imported for its effect by `analysis.service.ts`, which both the API and the worker load.
 */
const accessorsPath = '@duckdb/node-api/lib/vectors/dataAccessors.js';

export function keepLeadingBomInDuckDbText(): boolean {
  try {
    const accessors = createRequire(import.meta.url)(accessorsPath) as {
      textDecoder?: unknown;
    };
    if (!(accessors.textDecoder instanceof TextDecoder)) {
      throw new Error('it no longer exports textDecoder');
    }
    accessors.textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
    return true;
  } catch (err) {
    new Logger('DuckDbText').warn(
      `Could not make @duckdb/node-api keep a leading BOM in text (${(err as Error).message}): values and column names that start with U+FEFF will lose it.`,
    );
    return false;
  }
}

keepLeadingBomInDuckDbText();
