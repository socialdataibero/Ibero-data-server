import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { MappingChoiceDto } from './mapping-choice.dto.js';

export class SaveMappingDto {
  @IsArray({ message: 'columns must be a list.' })
  @ValidateNested({
    each: true,
    message: 'columns can only contain objects.',
  })
  @Type(() => MappingChoiceDto)
  columns!: MappingChoiceDto[];
}
