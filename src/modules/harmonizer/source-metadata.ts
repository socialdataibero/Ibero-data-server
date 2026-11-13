import { BadRequestException } from '@nestjs/common';

/** How a source was collected: every unit enumerated, or a sample where each record stands for several. */
export const SOURCE_DESIGNS = ['census', 'sample'] as const;
export type SourceDesign = (typeof SOURCE_DESIGNS)[number];

/** What each record of a source is. */
export const ANALYSIS_UNITS = ['person', 'dwelling', 'household'] as const;
export type AnalysisUnit = (typeof ANALYSIS_UNITS)[number];

/** Sample design role of a column: expansion factor, stratum, primary sampling unit. */
export const SOURCE_ROLES = ['weight', 'stratum', 'psu'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export type SourceInfoField = 'design' | 'unit';

/** The source fields an upload left out, in a fixed order. */
export function missingSourceInfo(dto: { design?: string; unit?: string }): SourceInfoField[] {
  const missing: SourceInfoField[] = [];
  if (!dto.design) missing.push('design');
  if (!dto.unit) missing.push('unit');
  return missing;
}

const SOURCE_INFO_TEXT: Record<SourceInfoField, string> = {
  design: 'the source design (census or sample)',
  unit: 'the unit of analysis (person, dwelling or household)',
};

/** Error body of an upload without design, unit or both (`params.missing` names them). */
export function sourceInfoRequiredBody(missing: SourceInfoField[]) {
  return {
    statusCode: 400,
    code: 'source_info_required',
    message: `Missing ${missing.map((f) => SOURCE_INFO_TEXT[f]).join(' and ')}.`,
    params: { missing },
  };
}

/** One column of a mapping as the role rules see it. */
export interface RoleChoice {
  column: string;
  mapped: boolean;
  role?: string | null;
}

/**
 * Role rules of a mapping, checked before it is saved:
 * - Only sample editions take roles (census ones and those without a design do not).
 * - A role needs a mapped column: unmapped columns are not in the harmonized view.
 * - At most one column per role.
 * - A sample edition needs a column marked as `weight`.
 */
export function assertSourceRoles(design: string | null, choices: RoleChoice[]): void {
  const withRole = choices.filter((c) => c.role);
  if (design !== 'sample') {
    if (withRole.length > 0) {
      throw new BadRequestException({
        code: 'source_role_not_allowed',
        message: `Only sample sources can mark sample design roles; column "${withRole[0].column}" has one.`,
        params: { column: withRole[0].column, role: withRole[0].role, design },
      });
    }
    return;
  }
  const unmapped = withRole.find((c) => !c.mapped);
  if (unmapped) {
    throw new BadRequestException({
      code: 'source_role_unmapped',
      message: `Column "${unmapped.column}" has the role "${unmapped.role}" but is not mapped to a variable.`,
      params: { column: unmapped.column, role: unmapped.role },
    });
  }
  for (const role of SOURCE_ROLES) {
    const columns = withRole.filter((c) => c.role === role).map((c) => c.column);
    if (columns.length > 1) {
      throw new BadRequestException({
        code: 'source_role_repeated',
        message: `Only one column can have the role "${role}"; these have it: ${columns.join(', ')}.`,
        params: { role, columns },
      });
    }
  }
  if (!withRole.some((c) => c.role === 'weight')) {
    throw new BadRequestException({
      code: 'sample_weight_required',
      message: 'Sample sources need one column marked as the expansion factor (role "weight").',
    });
  }
}
