import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { GEO_LEVELS, type GeoLevel } from '../variables/variable-role.js';
import {
  ANALYSIS_UNITS,
  SOURCE_DESIGNS,
  type AnalysisUnit,
  type SourceDesign,
} from '../source-metadata.js';

/** The place an edition covers, for the total row of an analysis. */
export class CoverageDto {
  @IsIn(GEO_LEVELS, { message: `coverage.level must be one of: ${GEO_LEVELS.join(', ')}.` })
  level!: GeoLevel;

  @IsString({ message: 'coverage.code must be a string.' })
  @MinLength(1, { message: 'coverage.code must not be empty.' })
  code!: string;

  @IsString({ message: 'coverage.label must be a string.' })
  @MinLength(1, { message: 'coverage.label must not be empty.' })
  label!: string;
}

/** Source fields of an edition that can change after the upload. */
export class UpdateDatasetDto {
  @IsOptional()
  @IsIn(SOURCE_DESIGNS, { message: `design must be one of: ${SOURCE_DESIGNS.join(', ')}.` })
  design?: SourceDesign;

  @IsOptional()
  @IsIn(ANALYSIS_UNITS, { message: `unit must be one of: ${ANALYSIS_UNITS.join(', ')}.` })
  unit?: AnalysisUnit;

  /** The place the edition covers; `null` clears it. */
  @IsOptional()
  @ValidateNested({ message: 'coverage must be an object or null.' })
  @Type(() => CoverageDto)
  coverage?: CoverageDto | null;
}
