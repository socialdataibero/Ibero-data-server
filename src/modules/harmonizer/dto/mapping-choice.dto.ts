import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { VALUE_TYPES, type ValueType } from '../harmonized-view.js';

export const NEW_CANONICAL = '__new__';
export const CANONICAL_PREFIX = 'cv:';

export class MappingChoiceDto {
  @IsString({ message: 'column must be a string.' })
  column!: string;
  @IsString({ message: 'choice must be a string.' })
  choice!: string;
  @IsOptional()
  @IsString({ message: 'newName must be a string.' })
  newName?: string;

  /** Tipo de la variable canónica. Si viene, se valida contra los valores y queda confirmado. */
  @IsOptional()
  @IsIn(VALUE_TYPES, {
    message: 'dataType must be "text", "integer" or "decimal".',
  })
  dataType?: ValueType;

  @IsOptional()
  @IsArray({ message: 'missingCodes must be a list.' })
  @IsString({ each: true, message: 'missingCodes can only contain strings.' })
  missingCodes?: string[];
}
