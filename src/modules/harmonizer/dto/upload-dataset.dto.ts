import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { DBF_ENCODINGS } from '../dbf.js';
import {
  ANALYSIS_UNITS,
  SOURCE_DESIGNS,
  type AnalysisUnit,
  type SourceDesign,
} from '../source-metadata.js';

/** An empty form field counts as missing, not as an invalid value. */
const emptyAsMissing = ({ value }: { value: unknown }) => (value === '' ? undefined : value);

export const NEW_SURVEY = '__new__';

/** Codificación de un DBF; `auto` la detecta. Un CSV siempre se lee como UTF-8. */
export const UPLOAD_ENCODINGS = ['auto', ...DBF_ENCODINGS] as const;
export type UploadEncoding = (typeof UPLOAD_ENCODINGS)[number];

export class UploadDatasetDto {
  @IsString({ message: 'name must be a string.' })
  @MinLength(1, { message: 'name must not be empty.' })
  name!: string;

  @Type(() => Number)
  @IsInt({ message: 'year must be an integer.' })
  @Min(1900, { message: 'year must not be earlier than 1900.' })
  @Max(2100, { message: 'year must not be later than 2100.' })
  year!: number;

  @IsString({ message: 'surveyId must be a string.' })
  @MinLength(1, { message: 'surveyId must not be empty.' })
  surveyId!: string;

  @IsOptional()
  @IsString({ message: 'newSurvey must be a string.' })
  newSurvey?: string;

  /** Owning organization of the new survey; required when surveyId is `__new__` (SDI-91). */
  @IsOptional()
  @IsString({ message: 'organizationId must be a string.' })
  organizationId?: string;

  @IsOptional()
  @IsIn(UPLOAD_ENCODINGS, {
    message: `encoding must be one of: ${UPLOAD_ENCODINGS.join(', ')}.`,
  })
  encoding?: UploadEncoding;

  /** Required, but checked after validation so one error can name both missing fields. */
  @Transform(emptyAsMissing)
  @IsOptional()
  @IsIn(SOURCE_DESIGNS, { message: `design must be one of: ${SOURCE_DESIGNS.join(', ')}.` })
  design?: SourceDesign;

  @Transform(emptyAsMissing)
  @IsOptional()
  @IsIn(ANALYSIS_UNITS, { message: `unit must be one of: ${ANALYSIS_UNITS.join(', ')}.` })
  unit?: AnalysisUnit;
}
