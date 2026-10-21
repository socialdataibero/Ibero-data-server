import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'fullName must be a string.' })
  @MinLength(2, { message: 'fullName must be at least 2 characters long.' })
  fullName!: string;
}
