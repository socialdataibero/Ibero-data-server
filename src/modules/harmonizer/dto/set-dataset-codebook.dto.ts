import { IsOptional, IsString, ValidateIf } from 'class-validator';

export class SetDatasetCodebookDto {
  /** Diccionario de la encuesta; `null` quita el de la edición. */
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'codebookId must be a string or null.' })
  codebookId!: string | null;

  /** Tabla (hoja) del diccionario. Sin ella se elige la que más columnas comparte con el archivo. */
  @IsOptional()
  @IsString({ message: 'table must be a string.' })
  table?: string;
}
