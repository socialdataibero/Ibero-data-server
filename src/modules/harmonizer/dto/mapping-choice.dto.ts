import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { VALUE_TYPES, type ValueType } from '../harmonized-view.js';

export const NEW_CANONICAL = '__new__';
export const CANONICAL_PREFIX = 'cv:';

export class MappingChoiceDto {
  @IsString()
  column!: string;
  @IsString()
  choice!: string;
  @IsOptional()
  @IsString()
  newName?: string;

  /** Tipo de la variable canónica. Si viene, se valida contra los valores y queda confirmado. */
  @IsOptional()
  @IsIn(VALUE_TYPES, {
    message: 'dataType debe ser "text", "integer" o "decimal".',
  })
  dataType?: ValueType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  missingCodes?: string[];
}
