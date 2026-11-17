import { IsArray, IsOptional, IsString } from 'class-validator';

/** A harmonized view to save as a resource: one edition, or a survey with its `variables`. */
export class AttachHarmonizedDto {
  @IsOptional()
  @IsString({ message: 'editionId must be a string.' })
  editionId?: string;

  @IsOptional()
  @IsString({ message: 'surveyId must be a string.' })
  surveyId?: string;

  /** Canonical variables of the survey view, as `variables` in its download. */
  @IsOptional()
  @IsArray({ message: 'variables must be a list.' })
  @IsString({ each: true, message: 'variables can only contain strings.' })
  variables?: string[];
}
