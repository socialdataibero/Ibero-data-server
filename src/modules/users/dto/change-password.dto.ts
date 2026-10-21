import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString({ message: 'currentPassword must be a string.' })
  @MinLength(1, { message: 'currentPassword must not be empty.' })
  currentPassword!: string;

  @IsString({ message: 'newPassword must be a string.' })
  @MinLength(8, { message: 'newPassword must be at least 8 characters long.' })
  newPassword!: string;
}
