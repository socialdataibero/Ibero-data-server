import { IsIn, IsOptional } from 'class-validator';
import {
  ANALYSIS_UNITS,
  SOURCE_DESIGNS,
  type AnalysisUnit,
  type SourceDesign,
} from '../source-metadata.js';

/** Source fields of an edition that can change after the upload. */
export class UpdateDatasetDto {
  @IsOptional()
  @IsIn(SOURCE_DESIGNS, { message: `design must be one of: ${SOURCE_DESIGNS.join(', ')}.` })
  design?: SourceDesign;

  @IsOptional()
  @IsIn(ANALYSIS_UNITS, { message: `unit must be one of: ${ANALYSIS_UNITS.join(', ')}.` })
  unit?: AnalysisUnit;
}
