import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { VALUE_TYPES, type ValueType } from '../harmonized-view.js';

export const NEW_CANONICAL = '__new__';
export const CANONICAL_PREFIX = 'cv:';

export class MappingChoiceDto {
  @IsString({ message: 'column debe ser texto.' })
  column!: string;
  @IsString({ message: 'choice debe ser texto.' })
  choice!: string;
  @IsOptional()
  @IsString({ message: 'newName debe ser texto.' })
  newName?: string;

  /** Tipo de la variable canónica. Si viene, se valida contra los valores y queda confirmado. */
  @IsOptional()
  @IsIn(VALUE_TYPES, {
    message: 'dataType debe ser "text", "integer" o "decimal".',
  })
  dataType?: ValueType;

  @IsOptional()
  @IsArray({ message: 'missingCodes debe ser una lista.' })
  @IsString({ each: true, message: 'missingCodes solo puede contener texto.' })
  missingCodes?: string[];
}
