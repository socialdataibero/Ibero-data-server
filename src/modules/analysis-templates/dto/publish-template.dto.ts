import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DatasetVisibility } from '@prisma/client';
import { PreviewTemplateDto } from './preview-template.dto.js';

/** A template run saved as an analysis of the dataset (`POST …/analyses/templates`). */
export class PublishTemplateDto extends PreviewTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug can only contain lowercase letters, numbers and hyphens' })
  @MaxLength(120)
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  folder!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsEnum(DatasetVisibility)
  visibility?: DatasetVisibility;
}
