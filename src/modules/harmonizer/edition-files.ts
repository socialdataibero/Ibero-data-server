/** Where the files of an edition live in storage, and how the cleanup recognizes them. */

// Cada edición se guarda una sola vez como Parquet todo-VARCHAR. Guardarla como
// un JSON por fila repetía el nombre de cada columna en cada fila (H-31).
export function rawStorageKey(datasetId: string): string {
  return `harmonizer/${datasetId}.parquet`;
}

// El CSV tal como se subió, comprimido con gzip. Solo existe para ediciones importadas
// por el worker (subida por tus); las demás regeneran «Descargar original» del Parquet.
export function originalStorageKey(datasetId: string): string {
  return `harmonizer/originals/${datasetId}.csv.gz`;
}

// `<id>.parquet` y, apartado para borrarse, `<id>.parquet.deleting`.
export const RAW_FILE = /^([0-9a-f-]{36})\.parquet(\.deleting)?$/;
// Lo mismo para los originales: `originals/<id>.csv.gz(.deleting)`.
export const ORIGINAL_FILE = /^([0-9a-f-]{36})\.csv\.gz(\.deleting)?$/;
// El worker escribe los archivos de una edición antes de crearla en la base. La limpieza
// no toca archivos tan recientes, para no borrar los de una importación en curso.
export const SWEEP_MIN_AGE_MS = 3600_000;

// Las columnas del Parquet crudo son posicionales (`c0`, `c1`, …) y los nombres
// reales viven en `HarmonizerDataset.columns`. DuckDB no distingue mayúsculas en
// los identificadores, así que `EDAD` y `edad` chocarían como nombres de columna.
export function rawColumnNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `c${i}`);
}
