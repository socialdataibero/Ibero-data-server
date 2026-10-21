import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSurveyDto {
  @IsString({ message: 'name must be a string.' })
  @MinLength(1, { message: 'name must not be empty.' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'description must be a string.' })
  description?: string;
}
