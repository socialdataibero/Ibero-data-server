import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from '../dto/mapping-choice.dto.js';

// Si la elección asigna una canónica (existente o nueva con nombre).
export function isMappedChoice(choice: MappingChoiceDto): boolean {
  if (choice.choice.startsWith(CANONICAL_PREFIX)) return true;
  return (
    choice.choice === NEW_CANONICAL && (choice.newName?.trim() ?? '') !== ''
  );
}

// Se recortan, se descartan vacíos y repetidos: el valor de la celda también se
// compara recortado (ver harmonized-view.ts).
export function normalizeMissingCodes(codes: string[] | undefined): string[] {
  return [
    ...new Set((codes ?? []).map((c) => c.trim()).filter((c) => c !== '')),
  ];
}
