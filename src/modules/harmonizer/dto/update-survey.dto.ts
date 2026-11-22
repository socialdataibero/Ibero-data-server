import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateSurveyDto {
  @IsOptional()
  @IsString({ message: 'name must be a string.' })
  @MinLength(1, { message: 'name must not be empty.' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'description must be a string.' })
  description?: string;

  /** Short name of the source, e.g. "Censo 2000"; empty clears it. */
  @IsOptional()
  @IsString({ message: 'shortName must be a string.' })
  shortName?: string;
}
