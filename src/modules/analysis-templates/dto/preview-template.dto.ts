import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';

/** A template run without saving (`POST …/analyses/templates/preview`). */
export class PreviewTemplateDto {
  @IsUUID('all', { message: 'resourceId must be a UUID.' })
  resourceId!: string;

  @IsString({ message: 'templateId must be a string.' })
  templateId!: string;

  /** Distribution: the variable whose categories are shown. */
  @IsOptional()
  @IsString({ message: 'variable must be a string.' })
  variable?: string;

  /** Proportion: the conditions, 1 to 6. */
  @IsOptional()
  @IsArray({ message: 'conditions must be a list.' })
  @ArrayMaxSize(6, { message: 'conditions can have at most 6 items.' })
  @IsString({ each: true, message: 'conditions can only contain strings.' })
  conditions?: string[];

  /** Weighted mean: the measure. */
  @IsOptional()
  @IsString({ message: 'measure must be a string.' })
  measure?: string;

  /** Optional variable that splits the result; `null` or absent: only the total. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'group must be a string or null.' })
  group?: string | null;

  @IsOptional()
  @IsIn(['exclude', 'include'], { message: 'missing must be exclude or include.' })
  missing?: 'exclude' | 'include';

  /** The edition of the analysis (an id of `editions`), needed when the resource has several. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'edition must be a string or null.' })
  edition?: string | null;
}
