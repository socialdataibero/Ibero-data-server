import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSurveyDto {
  @IsString({ message: 'name must be a string.' })
  @MinLength(1, { message: 'name must not be empty.' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'description must be a string.' })
  description?: string;

  /** Owning organization (SDI-91); the caller must be its ADMIN/EDITOR or the sysadmin. */
  @IsString({ message: 'organizationId must be a string.' })
  @MinLength(1, { message: 'organizationId must not be empty.' })
  organizationId!: string;
}
