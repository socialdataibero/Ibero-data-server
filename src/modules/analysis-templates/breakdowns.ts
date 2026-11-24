import { BadRequestException } from '@nestjs/common';
import type { VariableMetadata, VariableMetadataColumn } from './template-metadata.js';

/** Most breakdowns of one analysis, and most cells per condition (proposal, section 5.9). */
export const MAX_BREAKDOWNS = 2;
export const MAX_CELLS = 10_000;

/** Every subset of `items`, the empty one first: the marginal combinations of the breakdowns. */
export function combinations<T>(items: T[]): T[][] {
  return items.reduce<T[][]>((all, item) => [...all, ...all.map((c) => [...c, item])], [[]]);
}

/** Checks the breakdowns asked for: known, splittable, and not used anywhere else. */
export function resolveBreakdowns(
  names: string[],
  roles: string[],
  metadata: VariableMetadata,
  used: VariableMetadataColumn[],
): VariableMetadataColumn[] {
  const unique = [...new Set(names)];
  if (unique.length > MAX_BREAKDOWNS) {
    fail('template_too_many_breakdowns', `Choose at most ${MAX_BREAKDOWNS} breakdowns.`, { max: MAX_BREAKDOWNS });
  }
  const taken = new Set(used.map(origin));
  return unique.map((name) => {
    const column = metadata.columns.find((c) => c.name === name);
    if (!column || !roles.includes(column.role) || !column.categories?.length) {
      fail('template_breakdown_unavailable', `"${name}" cannot be used as a breakdown.`, { variable: name });
    }
    if (taken.has(origin(column))) {
      fail('template_variable_in_two_roles', `"${column.label}" is already used in this analysis.`, { variable: name });
    }
    taken.add(origin(column));
    return column;
  });
}

/** The column of the file a variable is read from: age groups are still the age. */
export function origin(column: VariableMetadataColumn): string {
  return column.cutFrom ?? column.name;
}

/** Rejects, before running, a request with more cells per condition than `MAX_CELLS`. */
export function checkCells(
  group: VariableMetadataColumn | null,
  breakdowns: VariableMetadataColumn[],
  series: VariableMetadataColumn | null,
): void {
  if (breakdowns.length === 0) return;
  const size = (c: VariableMetadataColumn | null) => c?.categories?.length ?? 0;
  const cells = breakdowns.reduce((n, b) => n * (size(b) + 1), (size(group) + 1) * Math.max(size(series), 1));
  if (cells > MAX_CELLS) {
    fail('template_too_many_cells', `This combination would give ${cells} cells; the most is ${MAX_CELLS}.`, {
      cells,
      max: MAX_CELLS,
    });
  }
}

function fail(code: string, message: string, params: Record<string, unknown>): never {
  throw new BadRequestException({ code, message, params });
}
