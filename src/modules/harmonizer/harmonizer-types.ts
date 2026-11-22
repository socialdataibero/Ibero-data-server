import type { CodebookVariableInfo } from './codebook.js';
import type { ColumnValues, ValueType } from './harmonized-view.js';
import type {
  AnalysisUnit,
  SourceDesign,
  SourceRole,
} from './source-metadata.js';

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
  };
}
