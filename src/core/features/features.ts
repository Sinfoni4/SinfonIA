import type { Permission } from '../authz/permissions.js';

/**
 * A03 (voce 16, B15): the functions the platform can switch off for one organization, from the
 * console. Practices, members, audit and the organization's settings are the Core and always on.
 *
 * Each function covers a set of permissions: when it is off, `authorize()` refuses them for every
 * role, on every channel (dashboard, API, chat), so hiding a menu is never the only protection.
 * Stored as the list of the functions turned off (`tenant.disabled_features`), so an
 * organization created before this keeps everything it had.
 */
export const FEATURES = [
  'ai_chat',
  'documents',
  'deadlines',
  'assistance',
  'exports',
  'delegations',
  'network_stats',
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  ai_chat: 'Assistente IA nella chat',
  documents: 'Documenti e lettura automatica',
  deadlines: 'Scadenze e promemoria',
  assistance: 'Richieste di assistenza',
  exports: 'Esportazioni',
  delegations: 'Deleghe tra organizzazioni',
  network_stats: 'Statistiche di rete',
};

export const FEATURE_PERMISSIONS: Record<Feature, readonly Permission[]> = {
  ai_chat: ['ai.execute'],
  documents: ['attachment.create', 'attachment.read', 'attachment.validate'],
  deadlines: ['compliance.read', 'compliance.manage'],
  assistance: ['assistance.request', 'assistance.manage'],
  exports: ['practice.export'],
  delegations: ['grant.issue', 'grant.beneficiaries', 'grant.use'],
  network_stats: ['network.stats'],
};

const FEATURE_BY_PERMISSION = new Map<Permission, Feature>(
  FEATURES.flatMap((f) => FEATURE_PERMISSIONS[f].map((p) => [p, f] as const)),
);

/** The function a permission belongs to; undefined for the Core's permissions. */
export function featureOf(permission: Permission): Feature | undefined {
  return FEATURE_BY_PERMISSION.get(permission);
}

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/** Whether a function is on, given the list of those turned off. */
export function featureEnabled(
  disabled: readonly string[] | null | undefined,
  feature: Feature,
): boolean {
  return !(disabled ?? []).includes(feature);
}

/** Message starts with FEATURE_DISABLED: chat channels turn it into the Italian reply. */
export class FeatureDisabledError extends Error {
  constructor(
    readonly feature: Feature,
    readonly permission: Permission,
  ) {
    super(`FEATURE_DISABLED: ${feature}`);
    this.name = 'FeatureDisabledError';
  }
}
