import { IsString } from 'class-validator';

export class RenameCanonicalVariableDto {
  @IsString({ message: 'name must be a string.' })
  name!: string;
}
