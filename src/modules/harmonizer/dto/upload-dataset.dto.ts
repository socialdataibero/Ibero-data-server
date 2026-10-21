import { Type } from 'class-transformer';
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

  @IsOptional()
  @IsIn(UPLOAD_ENCODINGS, {
    message: `encoding must be one of: ${UPLOAD_ENCODINGS.join(', ')}.`,
  })
  encoding?: UploadEncoding;
}
