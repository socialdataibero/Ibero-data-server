import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { MappingChoiceDto } from './mapping-choice.dto.js';

export class SaveMappingDto {
  @IsArray({ message: 'columns debe ser una lista.' })
  @ValidateNested({
    each: true,
    message: 'columns solo puede contener objetos.',
  })
  @Type(() => MappingChoiceDto)
  columns!: MappingChoiceDto[];
}
