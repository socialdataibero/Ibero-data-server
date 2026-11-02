import { IsOptional, IsString } from 'class-validator';

export class CreateCodebookDto {
  @IsOptional()
  @IsString({ message: 'name must be a string.' })
  name?: string;
}
