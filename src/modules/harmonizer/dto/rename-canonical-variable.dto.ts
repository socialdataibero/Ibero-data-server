import { IsString } from 'class-validator';

export class RenameCanonicalVariableDto {
  @IsString({ message: 'El nombre de la variable debe ser texto.' })
  name!: string;
}
