import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { DatasetVisibility } from '@prisma/client';

export class SaveVistraceAnalysisDto {
  @IsUUID()
  sourceResourceId!: string;

  @IsString()
  @MinLength(2)
  title!: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug can only contain lowercase letters, numbers and hyphens' })
  slug!: string;

  @IsString()
  @MinLength(1)
  folder!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(DatasetVisibility)
  visibility?: DatasetVisibility;

  @IsString()
  @MaxLength(5 * 1024 * 1024)
  recipe!: string;
}
