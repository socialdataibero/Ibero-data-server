import { IsArray, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsString()
  newDataType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  missingCodes?: string[];
}
