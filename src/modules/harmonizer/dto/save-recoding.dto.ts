import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class CatalogCategoryDto {
  @IsString({ message: 'code must be a string.' })
  code!: string;

  @IsOptional()
  @IsString({ message: 'label must be a string.' })
  label?: string;
}

export class ValueRecodingDto {
  @IsString({ message: 'from must be a string.' })
  from!: string;

  @IsString({ message: 'to must be a string.' })
  to!: string;
}

export class EditionRecodingDto {
  @IsString({ message: 'datasetId must be a string.' })
  datasetId!: string;

  @IsArray({ message: 'values must be a list.' })
  @ValidateNested({ each: true, message: 'values can only contain objects.' })
  @Type(() => ValueRecodingDto)
  values!: ValueRecodingDto[];
}

export class SaveRecodingDto {
  /** Catálogo de la variable. Una lista vacía lo quita. */
  @IsArray({ message: 'categories must be a list.' })
  @ValidateNested({ each: true, message: 'categories can only contain objects.' })
  @Type(() => CatalogCategoryDto)
  categories!: CatalogCategoryDto[];

  /** Recodificación por edición. Las ediciones que no vienen conservan la suya. */
  @IsArray({ message: 'editions must be a list.' })
  @ValidateNested({ each: true, message: 'editions can only contain objects.' })
  @Type(() => EditionRecodingDto)
  editions!: EditionRecodingDto[];
}
