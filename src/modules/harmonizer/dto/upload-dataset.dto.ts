import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export const NEW_SURVEY = '__new__';

export class UploadDatasetDto {
  @IsString({ message: 'name debe ser texto.' })
  @MinLength(1, { message: 'name no puede quedar vacío.' })
  name!: string;

  @Type(() => Number)
  @IsInt({ message: 'year debe ser un número entero.' })
  @Min(1900, { message: 'year no puede ser anterior a 1900.' })
  @Max(2100, { message: 'year no puede ser posterior a 2100.' })
  year!: number;

  @IsString({ message: 'surveyId debe ser texto.' })
  @MinLength(1, { message: 'surveyId no puede quedar vacío.' })
  surveyId!: string;

  @IsOptional()
  @IsString({ message: 'newSurvey debe ser texto.' })
  newSurvey?: string;
}
