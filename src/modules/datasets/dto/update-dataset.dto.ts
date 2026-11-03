import { IsArray, IsEnum, IsInt, IsOptional, IsString, IsUrl, Max, Min, MinLength, ValidateIf } from 'class-validator';
import { DatasetVisibility, PeriodType, Survey } from '@prisma/client';

/**
 * Editable dataset metadata (SDI-132). The slug and the revision chain stay as created:
 * the slug identifies the dataset and revisions are new datasets, not edits.
 * Optional fields accept null to clear them; title, visibility and tags cannot be null.
 */
export class UpdateDatasetDto {
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MinLength(2)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @ValidateIf((_, v) => v !== undefined)
  @IsEnum(DatasetVisibility)
  visibility?: DatasetVisibility;

  @IsOptional()
  @IsEnum(Survey)
  survey?: Survey | null;

  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(2099)
  year?: number | null;

  @IsOptional()
  @IsEnum(PeriodType)
  periodType?: PeriodType | null;

  @IsOptional()
  @IsString()
  sourceOrg?: string | null;

  @IsOptional()
  @IsUrl()
  sourceUrl?: string | null;

  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  licenseId?: string | null;

  @IsOptional()
  @IsString()
  changelog?: string | null;
}
