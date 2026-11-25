import { MAX_BREAKDOWNS, origin } from './breakdowns.js';
import type { VariableMetadata, VariableRole } from './template-metadata.js';

/**
 * The three base templates of the proposal (section 7), written in code for the demo. In the full
 * plan they become JSON contracts checked against their schema and read by a generic orchestrator
 * (`planes-pendientes/plantillas-analisis.md`, phase 5). Names, descriptions and texts are copied
 * from the contracts in `propuesta_plantillas/`, in Spanish because they are shown as they are.
 */

export const TEMPLATE_IDS = ['distribution', 'proportion', 'weighted_mean'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type InputName = 'variable' | 'conditions' | 'measure' | 'group' | 'breakdowns';
export type MissingChoice = 'exclude' | 'include';

export interface InputSpec {
  name: InputName;
  /** Label of its selector. */
  label: string;
  help: string;
  roles: VariableRole[];
  optional: boolean;
  /** Present when the input takes a list. */
  multiple?: { min: number; max: number };
  /** Most categories a variable may have here (from its metadata). */
  maxCategories?: number;
}

export interface TemplateDefinition {
  id: TemplateId;
  version: 1;
  /** `<id>@<version>` of the contract it comes from. */
  contract: string;
  name: string;
  description: string;
  /** What the chart is for: compare or part of the whole (section 6.8). */
  purpose: 'compare' | 'part_of_whole';
  inputs: InputSpec[];
  /** Input whose "not specified" codes the user may include or exclude; `null`: always excluded. */
  missingInput: 'variable' | 'conditions' | null;
}

const GROUP_ROLES: VariableRole[] = ['geographic', 'category', 'ordinal', 'dichotomous'];

const group = (help: string): InputSpec => ({
  name: 'group',
  label: 'Por grupo (opcional)',
  help,
  roles: GROUP_ROLES,
  optional: true,
  maxCategories: 50,
});

/** Splits every figure further; the result has each combination and its «Todos». */
const breakdowns: InputSpec = {
  name: 'breakdowns',
  label: 'Cruzar por (opcional)',
  help: 'Parte cada cifra por otras variables, por ejemplo sexo y grupos de edad.',
  roles: ['category', 'ordinal', 'dichotomous'],
  optional: true,
  multiple: { min: 0, max: MAX_BREAKDOWNS },
  maxCategories: 30,
};

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'proportion',
    version: 1,
    contract: 'proporcion@2',
    name: 'Proporción',
    description:
      'Para una o varias condiciones, cuántas unidades las cumplen y qué proporción representan, con dos bases a elegir: el universo propio de cada condición o la población total.',
    purpose: 'compare',
    inputs: [
      {
        name: 'conditions',
        label: 'Condiciones',
        help: 'Qué se cuenta. Sólo se ofrecen variables de sí o no.',
        roles: ['dichotomous'],
        optional: false,
        multiple: { min: 1, max: 6 },
      },
      group('Calcula la proporción en cada grupo, además del total.'),
      breakdowns,
    ],
    missingInput: 'conditions',
  },
  {
    id: 'distribution',
    version: 1,
    contract: 'distribucion@1',
    name: 'Distribución',
    description:
      'Cuántas unidades hay en cada categoría de una variable y qué parte del total representa cada una.',
    purpose: 'part_of_whole',
    inputs: [
      {
        name: 'variable',
        label: 'Variable',
        help: 'La variable cuyas categorías se reparten. Sólo se ofrecen variables con categorías.',
        roles: ['category', 'ordinal', 'dichotomous', 'geographic'],
        optional: false,
        maxCategories: 30,
      },
      group('Reparte la población dentro de cada grupo, además del total.'),
      breakdowns,
    ],
    missingInput: 'variable',
  },
  {
    id: 'weighted_mean',
    version: 1,
    contract: 'promedio_ponderado@1',
    name: 'Promedio',
    description:
      'El valor promedio de una medida, ponderado por el factor de expansión, en total o para cada grupo.',
    purpose: 'compare',
    inputs: [
      {
        name: 'measure',
        label: 'Medida',
        help: 'Una cantidad, como la edad. Nunca un código.',
        roles: ['measure'],
        optional: false,
      },
      group('Calcula el promedio en cada grupo, además del total.'),
      breakdowns,
    ],
    missingInput: null,
  },
];

export function findTemplate(id: string): TemplateDefinition | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

/** A column a selector can offer. */
export interface InputOption {
  column: string;
  label: string;
  role: VariableRole;
  categoryCount: number | null;
  hasMissingCodes: boolean;
  universe: string | null;
  /** The column it is read from: the groups of a measure cannot split that same measure. */
  origin: string;
}

export interface TemplateListing {
  id: TemplateId;
  version: 1;
  contract: string;
  name: string;
  description: string;
  compatible: boolean;
  /** Why it cannot be used with this resource (`code` for the web, `message` in English). */
  reason: { code: string; message: string } | null;
  inputs: (InputSpec & { options: InputOption[] })[];
  missing: { input: 'variable' | 'conditions'; options: MissingChoice[]; default: MissingChoice } | null;
}

/** The columns of `metadata` an input can take. */
export function inputOptions(input: InputSpec, metadata: VariableMetadata): InputOption[] {
  return metadata.columns
    .filter((c) => input.roles.includes(c.role))
    .filter((c) => input.name !== 'breakdowns' || (c.categories?.length ?? 0) > 0)
    .filter((c) => input.maxCategories === undefined || (c.categories?.length ?? 0) <= input.maxCategories)
    .map((c) => ({
      column: c.name,
      label: c.label,
      role: c.role,
      categoryCount: c.categories?.length ?? null,
      hasMissingCodes: (c.missingCodes?.length ?? 0) > 0,
      universe: c.universe ?? null,
      origin: origin(c),
    }));
}

/** Every template, with what it needs and whether this resource has it (section 2.3, step 1). */
export function listTemplates(metadata: VariableMetadata | null): TemplateListing[] {
  return TEMPLATES.map((t) => {
    const inputs = t.inputs.map((input) => ({ ...input, options: metadata ? inputOptions(input, metadata) : [] }));
    let reason: TemplateListing['reason'] = null;
    if (!metadata) {
      reason = {
        code: 'template_no_metadata',
        message:
          'This resource has no source metadata from the harmonizer, so no template can use it. Save it again from the harmonizer.',
      };
    } else if (metadata.design === 'sample' && !metadata.columns.some((c) => c.role === 'weight')) {
      reason = {
        code: 'template_factor_required',
        message: 'This source is a sample and has no expansion factor declared.',
      };
    } else {
      const lacking = inputs.find((i) => !i.optional && i.options.length === 0);
      if (lacking) {
        reason = {
          code: 'template_input_unavailable',
          message: `No variable of this resource can be used as "${lacking.name}".`,
        };
      }
    }
    return {
      id: t.id,
      version: t.version,
      contract: t.contract,
      name: t.name,
      description: t.description,
      compatible: reason === null,
      reason,
      inputs,
      missing: t.missingInput ? { input: t.missingInput, options: ['exclude', 'include'], default: 'exclude' } : null,
    };
  });
}
