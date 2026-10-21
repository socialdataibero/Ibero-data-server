export type DuckDbErrorReason =
  | 'invalid_value'
  | 'unknown_column'
  | 'incompatible_types'
  | 'syntax_error'
  | 'unknown_table'
  | 'out_of_memory'
  | 'io_error'
  | 'unknown';

export type ValueType = 'integer' | 'number' | 'date' | 'timestamp' | 'boolean' | 'other';

export interface DuckDbErrorInfo {
  reason: DuckDbErrorReason;
  message: string;
  params?: Record<string, string>;
}

const VALUE_TYPES: [RegExp, ValueType][] = [
  [/^U?(TINY|SMALL|HUGE|BIG)?INT(8|16|32|64|128|EGER)?$/, 'integer'],
  [/^(DOUBLE|FLOAT|REAL|DECIMAL.*)$/, 'number'],
  [/^DATE$/, 'date'],
  [/^TIMESTAMP.*$/, 'timestamp'],
  [/^BOOL(EAN)?$/, 'boolean'],
];

const MAX_VALUE_LENGTH = 60;

const MESSAGES: Record<Exclude<DuckDbErrorReason, 'invalid_value' | 'unknown_column'>, string> = {
  incompatible_types: 'The analysis combines columns or values of incompatible types.',
  syntax_error: 'The SQL query has a syntax error.',
  unknown_table: 'The query uses a table or function that does not exist. The data table is called "data".',
  out_of_memory: 'The analysis needs more memory than is available.',
  io_error: 'The data file could not be read or written.',
  unknown: 'The analysis could not be run.',
};

const REASON_BY_KIND: Record<string, keyof typeof MESSAGES> = {
  'Binder Error': 'incompatible_types',
  'Conversion Error': 'incompatible_types',
  'Parser Error': 'syntax_error',
  'Catalog Error': 'unknown_table',
  'Out of Memory Error': 'out_of_memory',
  'IO Error': 'io_error',
};

function valueType(duckType: string): ValueType {
  return VALUE_TYPES.find(([re]) => re.test(duckType))?.[1] ?? 'other';
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/**
 * Classifies a raw DuckDB error for API clients. The result never contains the SQL,
 * file paths or DuckDB's own text; the raw message is meant for the server log only.
 */
export function describeDuckDbError(duckMessage: string): DuckDbErrorInfo {
  const conversion = /Could not convert string '(.*?)' to (\w+)/.exec(duckMessage);
  if (conversion) {
    const value = truncate(conversion[1]);
    const expectedType = valueType(conversion[2]);
    return {
      reason: 'invalid_value',
      message: `The value "${value}" is not a valid ${expectedType} for this column.`,
      params: { value, expectedType },
    };
  }

  const missingColumn = /(?:Referenced column|column named) "(.*?)"/.exec(duckMessage);
  if (missingColumn) {
    const column = truncate(missingColumn[1]);
    return {
      reason: 'unknown_column',
      message: `The column "${column}" does not exist in the data.`,
      params: { column },
    };
  }

  const reason = REASON_BY_KIND[duckMessage.split(':', 1)[0]] ?? 'unknown';
  return { reason, message: MESSAGES[reason] };
}
