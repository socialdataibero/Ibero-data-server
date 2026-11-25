import type { CodebookVariableInfo } from './codebook.js';
import type { ColumnValues, ValueType } from './harmonized-view.js';
import type {
  AnalysisUnit,
  SourceDesign,
  SourceRole,
} from './source-metadata.js';
import { GEO_LEVELS, type GeoLevel } from './variables/variable-role.js';

/** Shapes of the harmonizer's responses, shared by the service, the worker and other modules. */

export interface SurveyDatasetSummary {
  id: string;
  name: string;
  year: number;
  rowCount: number;
  mappedColumns: number;
  totalColumns: number;
}

export interface SurveySummary {
  id: string;
  name: string;
  description: string | null;
  /** Short name of the source for notes; null = not given. */
  shortName: string | null;
  /** Owner (SDI-91); null on surveys created before ownership existed. */
  organizationId: string | null;
  datasets: SurveyDatasetSummary[];
}

export interface ListSurveysParams {
  limit?: number;
  offset?: number;
}

export interface DatasetInfo {
  id: string;
  name: string;
  year: number;
  surveyId: string;
  surveyName: string;
  // Filas de datos leídas del archivo, sin contar el encabezado ni, en un DBF,
  // los registros borrados (H-09).
  rowCount: number;
  // Columnas del archivo, mapeadas o no (H-18).
  columnCount: number;
  // Diseño y unidad de análisis de la fuente; null en ediciones subidas antes de pedirlos.
  design: SourceDesign | null;
  unit: AnalysisUnit | null;
  /** The place the edition covers, for the total row of an analysis; null = not given. */
  coverage: Coverage | null;
}

/** The place an edition covers: level (see `GEO_LEVELS`), code and name. */
export interface Coverage {
  level: GeoLevel;
  code: string;
  label: string;
}

/** The stored coverage of an edition, or null when there is none or it has another shape. */
export function readCoverage(json: unknown): Coverage | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const c = json as Record<string, unknown>;
  if (
    !(GEO_LEVELS as readonly unknown[]).includes(c.level) ||
    typeof c.code !== 'string' ||
    typeof c.label !== 'string'
  ) {
    return null;
  }
  return { level: c.level as GeoLevel, code: c.code, label: c.label };
}

export interface ViewPageParams {
  limit?: number;
  offset?: number;
}

export interface ViewPage {
  limit: number;
  offset: number;
}

export type SuggestionSource = 'history' | 'name' | 'description';

/** Lo que dice el diccionario de la edición sobre una columna. */
export interface ColumnCodebook extends CodebookVariableInfo {
  // Códigos de «No especificado» del diccionario, escritos como vienen en los datos.
  missingCodes: string[];
  // Tipo que sugieren el diccionario y los valores, sin los códigos de `missingCodes`.
  suggestedType: ValueType;
}

export interface MappingColumn {
  name: string;
  selectedCanonicalId: string | null;
  suggested: string | null;
  suggestionSource: SuggestionSource | null;
  missingCodes: string[];
  // Rol de diseño muestral guardado; null = ninguno.
  role: SourceRole | null;
  // Con rol `certainty`: los códigos que marcan un estrato de enumeración completa.
  certaintyCodes: string[];
  // Tipo que sugieren los valores de esta edición, con sus códigos guardados.
  inferredType: ValueType;
  values: ColumnValues;
  codebook: ColumnCodebook | null;
}

export interface CanonicalVariableInfo {
  id: string;
  name: string;
  description: string | null;
  // `null` = nadie lo ha confirmado todavía.
  dataType: ValueType | null;
}

/** The edition as the API answers it. */
export function toDatasetInfo(dataset: {
  id: string;
  name: string;
  year: number;
  surveyId: string;
  rowCount: number;
  columns: string[];
  design: string | null;
  unit: string | null;
  coverage?: unknown;
  survey: { name: string };
}): DatasetInfo {
  return {
    id: dataset.id,
    name: dataset.name,
    year: dataset.year,
    surveyId: dataset.surveyId,
    surveyName: dataset.survey.name,
    rowCount: dataset.rowCount,
    columnCount: dataset.columns.length,
    design: dataset.design as SourceDesign | null,
    unit: dataset.unit as AnalysisUnit | null,
    coverage: readCoverage(dataset.coverage),
  };
}
