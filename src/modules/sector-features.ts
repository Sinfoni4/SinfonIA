import {
  CAP_FILE_RECORDS,
  FARM_FUEL_RECORDS,
  FIELD_BOOK_RECORDS,
  LICENSE_RECORDS,
  ORGANIC_RECORDS,
  RISK_ASSESSMENT_RECORDS,
  TRAINING_RECORDS,
  type SectorRecordKind,
} from './sector-records.js';

import type { ModuleId } from '../core/modules/module.contract.js';

/**
 * Data, like the modules: the Core reaches it through registry.ts.
 *
 * The functions of a sector (agriculture, crafts, ...): each one belongs to one or more sector
 * modules and is switched on by the platform for an organization of that sector, from the console.
 *
 * Unlike the common functions (features.ts), which are on unless turned off, these start off:
 * they are stored as the list of the ones turned on (`tenant.enabled_features`), and only those of
 * the organization's own module count, so changing the sector hides the others.
 *
 * `ready: false` marks a function still being built: it can already be turned on, and the
 * dashboard and the Mini App show it as «in preparazione». A built function has a register
 * (`records`, sector-records.ts) and two permissions of its own, `<id>.read` and `<id>.manage`.
 */
export type SectorFeatureDefinition = {
  id: string;
  label: string;
  /** One sentence for people: what the function does. */
  description: string;
  modules: readonly ModuleId[];
  ready: boolean;
  /** The kinds of entry of its register; only for a built function. */
  records?: readonly SectorRecordKind[];
};

export const SECTOR_FEATURES = [
  {
    id: 'risk_assessment',
    label: 'Documento di valutazione dei rischi',
    description:
      'Il DVR dell’azienda con i suoi aggiornamenti, le figure della sicurezza e i documenti collegati.',
    modules: ['agri', 'artisan'],
    ready: true,
    records: RISK_ASSESSMENT_RECORDS,
  },
  {
    id: 'field_book',
    label: 'Quaderno di campagna',
    description:
      'Registro dei trattamenti e delle lavorazioni per appezzamento, da compilare anche dal telefono.',
    modules: ['agri'],
    ready: true,
    records: FIELD_BOOK_RECORDS,
  },
  {
    id: 'cap_file',
    label: 'Fascicolo e scadenze PAC',
    description: 'Fascicolo aziendale, domanda unica PAC e le relative scadenze.',
    modules: ['agri'],
    ready: true,
    records: CAP_FILE_RECORDS,
  },
  {
    id: 'farm_fuel',
    label: 'Carburante agricolo',
    description: 'Assegnazione UMA del gasolio agevolato: richieste, consumi e fatture.',
    modules: ['agri'],
    ready: true,
    records: FARM_FUEL_RECORDS,
  },
  {
    id: 'organic_certification',
    label: 'Certificazioni BIO',
    description: 'Certificazioni biologiche e di qualità, con documenti e rinnovi.',
    modules: ['agri'],
    ready: true,
    records: ORGANIC_RECORDS,
  },
  {
    id: 'training_safety',
    label: 'Formazione e sicurezza',
    description:
      'Corsi obbligatori (sicurezza, primo soccorso, antincendio) e attestati in scadenza per ogni addetto.',
    modules: ['agri', 'artisan'],
    ready: true,
    records: TRAINING_RECORDS,
  },
  {
    id: 'trade_licenses',
    label: 'Abilitazioni e patentini',
    description:
      'Patentini e abilitazioni delle persone (fitosanitari, macchine, impianti, F-gas) con le scadenze di rinnovo.',
    modules: ['agri', 'artisan'],
    ready: true,
    records: LICENSE_RECORDS,
  },
  {
    id: 'grants',
    label: 'Bandi e contributi',
    description: 'Bandi segnalati alle imprese e raccolta delle adesioni.',
    modules: ['artisan'],
    ready: false,
  },
  {
    id: 'business_startup',
    label: 'Avvio e variazioni d’impresa',
    description: 'SCIA, iscrizione all’albo delle imprese artigiane e pratiche camerali.',
    modules: ['artisan'],
    ready: false,
  },
  {
    id: 'waste_records',
    label: 'Rifiuti: registri e MUD',
    description: 'Registro di carico e scarico, formulari, RENTRI e dichiarazione MUD annuale.',
    modules: ['artisan'],
    ready: false,
  },
] as const satisfies readonly SectorFeatureDefinition[];

export type SectorFeature = (typeof SECTOR_FEATURES)[number]['id'];

export const SECTOR_FEATURE_IDS = SECTOR_FEATURES.map((f) => f.id) as [
  SectorFeature,
  ...SectorFeature[],
];

const BY_ID = new Map<string, SectorFeatureDefinition>(SECTOR_FEATURES.map((f) => [f.id, f]));

export function isSectorFeature(value: string): value is SectorFeature {
  return BY_ID.has(value);
}

export function sectorFeature(id: string): SectorFeatureDefinition | undefined {
  return BY_ID.get(id);
}

/** The kind of entry of a function's register, if both exist. */
export function sectorRecordKind(feature: string, kind: string): SectorRecordKind | undefined {
  return BY_ID.get(feature)?.records?.find((r) => r.kind === kind);
}

/** Whether a function of a sector exists for organizations of this module. */
export function sectorFeatureApplies(id: string, module: string): boolean {
  return (BY_ID.get(id)?.modules as readonly string[] | undefined)?.includes(module) ?? false;
}

/** The functions of the module's sector, in catalog order. */
export function sectorFeaturesOf(module: string): SectorFeatureDefinition[] {
  return SECTOR_FEATURES.filter((f) => (f.modules as readonly string[]).includes(module));
}

/** The functions of a sector that are on for an organization: turned on and of its module. */
export function activeSectorFeatures(
  module: string,
  enabled: readonly string[] | null | undefined,
): SectorFeatureDefinition[] {
  const on = new Set(enabled ?? []);
  return sectorFeaturesOf(module).filter((f) => on.has(f.id));
}

/** Where a function of a sector is shown: the dashboard, the Telegram Mini App, or both. */
export const SECTOR_CHANNELS = ['dashboard', 'miniapp'] as const;
export type SectorChannel = (typeof SECTOR_CHANNELS)[number];

export type ActiveSectorFeature = SectorFeatureDefinition & {
  dashboard: boolean;
  miniApp: boolean;
};

/**
 * The functions of a sector on for an organization in at least one place, each with where it is
 * shown: the dashboard (`enabled_features`) and the Mini App (`miniapp_features`) are chosen apart.
 */
export function sectorFeaturesOn(
  module: string,
  lists: {
    dashboard: readonly string[] | null | undefined;
    miniApp: readonly string[] | null | undefined;
  },
): ActiveSectorFeature[] {
  const dashboard = new Set(lists.dashboard ?? []);
  const miniApp = new Set(lists.miniApp ?? []);
  return sectorFeaturesOf(module)
    .map((f) => ({ ...f, dashboard: dashboard.has(f.id), miniApp: miniApp.has(f.id) }))
    .filter((f) => f.dashboard || f.miniApp);
}
