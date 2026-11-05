import { AGRI_MODULE } from './agri.module.js';
import { GENERIC_MODULE } from './generic.module.js';
import { MUSIC_MODULE } from './music.module.js';

import type {
  ModuleId,
  PracticeTypeDefinition,
  VerticalModule,
} from '../core/modules/module.contract.js';
import type { ComplianceCategory } from '@prisma/client';

/** A02: the modules SinfonIA knows; the Core reaches them only through this file. */
export const MODULES: Readonly<Record<ModuleId, VerticalModule>> = {
  generic: GENERIC_MODULE,
  music: MUSIC_MODULE,
  agri: AGRI_MODULE,
};

/**
 * Every practice kind of every module (a test checks it matches the definitions). Listed here so
 * that the type stays a union the compiler checks.
 */
export const PRACTICE_KINDS = ['artist', 'music', 'generic', 'agri'] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

const TYPES_BY_KIND = new Map<string, PracticeTypeDefinition>(
  Object.values(MODULES).flatMap((m) => m.practiceTypes.map((t) => [t.kind, t] as const)),
);

export function isModuleId(value: string): value is ModuleId {
  return Object.prototype.hasOwnProperty.call(MODULES, value);
}

/** The module of an organization; an unknown value (old data) falls back to the generic one. */
export function getModule(id: string | null | undefined): VerticalModule {
  return id && isModuleId(id) ? MODULES[id] : GENERIC_MODULE;
}

export function practiceTypeOf(kind: string): PracticeTypeDefinition | undefined {
  return TYPES_BY_KIND.get(kind);
}

/** Whether an organization of this module may create practices of this kind. */
export function moduleAllowsKind(module: VerticalModule, kind: string): boolean {
  return module.practiceTypes.some((t) => t.kind === kind);
}

/** Deadline categories of the module; ALTRO is always there. */
export function deadlineCategoriesOf(module: VerticalModule): readonly ComplianceCategory[] {
  return module.deadlineCategories.includes('ALTRO')
    ? module.deadlineCategories
    : [...module.deadlineCategories, 'ALTRO'];
}
