import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** One group of a measure: `[from, to]` inclusive, `to: null` = open ("y más"). */
export class AgeCutDto {
  @IsNumber({}, { message: 'from must be a number.' })
  from!: number;

  @ValidateIf((_, value) => value !== null)
  @IsNumber({}, { message: 'to must be a number or null.' })
  to!: number | null;

  @IsString({ message: 'label must be a string.' })
  label!: string;
}

export class DisaggregationDto {
  @IsBoolean({ message: 'summable must be true or false.' })
  summable!: boolean;

  @IsOptional()
  @IsArray({ message: 'cuts must be a list.' })
  @ValidateNested({ each: true, message: 'cuts can only contain objects.' })
  @Type(() => AgeCutDto)
  cuts?: AgeCutDto[];

  @IsOptional()
  @IsString({ message: 'notApplicableLabel must be a string.' })
  notApplicableLabel?: string | null;

  @IsOptional()
  @IsString({ message: 'maxLevel must be a string.' })
  maxLevel?: string | null;
}

/**
 * `PUT /harmonizer/surveys/:surveyId/variables/:variableId/analysis`: how the variable is used
 * in analysis. It replaces what was saved; a field left out is cleared. The rules per role are
 * in variables/variable-role.ts.
 */
export class SaveVariableAnalysisDto {
  @IsOptional()
  @IsString({ message: 'role must be a string or null.' })
  role?: string | null;

  @IsOptional()
  @IsString({ message: 'universe must be a string or null.' })
  universe?: string | null;

  @IsOptional()
  @IsString({ message: 'positiveValue must be a string or null.' })
  positiveValue?: string | null;

  @IsOptional()
  @IsString({ message: 'geoLevel must be a string or null.' })
  geoLevel?: string | null;

  @IsOptional()
  @IsString({ message: 'unit must be a string or null.' })
  unit?: string | null;

  @IsOptional()
  @ValidateNested({ message: 'disaggregation must be an object or null.' })
  @Type(() => DisaggregationDto)
  disaggregation?: DisaggregationDto | null;
}
