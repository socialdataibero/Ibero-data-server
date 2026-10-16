import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSurveyDto {
  @IsString({ message: 'name debe ser texto.' })
  @MinLength(1, { message: 'name no puede quedar vacío.' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'description debe ser texto.' })
  description?: string;
}
