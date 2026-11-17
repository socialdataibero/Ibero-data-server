import { IsObject } from 'class-validator';

/** The variable metadata of a resource (analysis/variable-metadata.ts checks its shape). */
export class SetVariableMetadataDto {
  @IsObject({ message: 'metadata must be an object.' })
  metadata!: Record<string, unknown>;
}
