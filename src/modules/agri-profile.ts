import type { FieldDefinition } from '../core/modules/module.contract.js';

/**
 * Data, like the modules and the registers: the questionnaire of the profile of a company of a
 * sector (Fase 1C). A company declares its activities (several at once) and, for each, a few
 * details; the common part is asked to every company. Nothing here makes an obligation: the
 * profile describes the company, the catalog of modules (Fase 1D) will only suggest.
 *
 * First version, to be checked with TerreFVG: being data, it changes without a migration. A
 * field marked `required` does not block saving: it makes the profile «incompleto».
 */

export type ProfileActivity = {
  /** Stable identifier stored in the profile. */
  id: string;
  label: string;
  /** One sentence for people. */
  description: string;
  fields: readonly FieldDefinition[];
};

export type CompanyProfileDefinition = {
  /** The version of the questionnaire, shown with the profile. */
  edition: string;
  /** Asked to every company. */
  common: readonly FieldDefinition[];
  activities: readonly ProfileActivity[];
};

const HECTARES = (key: string, label: string, required = false): FieldDefinition => ({
  key,
  label,
  type: 'number',
  min: 0,
  max: 100_000,
  decimals: 4,
  ...(required ? { required: true } : {}),
});

const TEXT = (key: string, label: string, required = false, maxLength = 300): FieldDefinition => ({
  key,
  label,
  type: 'text',
  maxLength,
  ...(required ? { required: true } : {}),
});

export const AGRI_PROFILE: CompanyProfileDefinition = {
  edition: '2026-11 (prima versione, da verificare con TerreFVG)',
  common: [
    TEXT('units', 'Unità produttive e sedi (comune, località)', true, 500),
    TEXT('caa', 'CAA di riferimento'),
    TEXT('advisor', 'Consulente o studio di riferimento'),
    {
      key: 'staff',
      label: 'Addetti (titolare compreso)',
      type: 'number',
      min: 0,
      max: 10_000,
      decimals: 0,
    },
    TEXT('notes', 'Note', false, 1000),
  ],
  activities: [
    {
      id: 'crops',
      label: 'Coltivazioni e seminativi',
      description: 'Cereali, foraggere, colture industriali.',
      fields: [
        HECTARES('area', 'Superficie coltivata (ha)', true),
        TEXT('crops', 'Colture principali'),
        HECTARES('irrigatedArea', 'Di cui irrigata (ha)'),
      ],
    },
    {
      id: 'fruit_veg',
      label: 'Ortofrutta',
      description: 'Orticole, frutteti, piccoli frutti.',
      fields: [
        HECTARES('area', 'Superficie (ha)', true),
        TEXT('crops', 'Colture principali'),
        {
          key: 'greenhouse',
          label: 'Coltivazione in serra',
          type: 'choice',
          options: [
            { value: 'no', label: 'No' },
            { value: 'partly', label: 'In parte' },
            { value: 'yes', label: 'Sì' },
          ],
        },
      ],
    },
    {
      id: 'vineyard_winery',
      label: 'Viticoltura e cantina',
      description: 'Vigneti, vinificazione, imbottigliamento.',
      fields: [
        HECTARES('vineyardArea', 'Superficie a vigneto (ha)', true),
        TEXT('varieties', 'Vitigni principali'),
        {
          key: 'winery',
          label: 'Cantina',
          type: 'choice',
          options: [
            { value: 'none', label: 'Nessuna: conferisce le uve' },
            { value: 'own', label: 'Vinifica in proprio' },
            { value: 'own_bottling', label: 'Vinifica e imbottiglia' },
          ],
        },
        TEXT('designations', 'Denominazioni (DOC, IGT…)'),
      ],
    },
    {
      id: 'livestock',
      label: 'Allevamento',
      description: 'Bovini, ovicaprini, suini, avicoli, api…',
      fields: [
        TEXT('species', 'Specie allevate', true),
        {
          key: 'heads',
          label: 'Capi complessivi (circa)',
          type: 'number',
          min: 0,
          max: 10_000_000,
          decimals: 0,
        },
        TEXT('herdCode', 'Codice aziendale di allevamento', false, 60),
      ],
    },
    {
      id: 'brewery',
      label: 'Birrificio',
      description: 'Produzione di birra, anche agricola.',
      fields: [
        {
          key: 'regime',
          label: 'Regime',
          type: 'choice',
          required: true,
          options: [
            { value: 'agricultural', label: 'Birrificio agricolo' },
            { value: 'craft', label: 'Birrificio artigianale' },
            { value: 'unknown', label: 'Da definire' },
          ],
        },
        TEXT('exciseCode', 'Codice ditta / licenza ADM', false, 60),
        {
          key: 'yearlyHl',
          label: 'Produzione annua (hl, circa)',
          type: 'number',
          min: 0,
          max: 10_000_000,
          decimals: 1,
        },
      ],
    },
    {
      id: 'food_processing',
      label: 'Trasformazione alimentare',
      description: 'Formaggi, salumi, conserve, olio, farine…',
      fields: [
        TEXT('products', 'Prodotti trasformati', true),
        TEXT('plant', 'Laboratorio o stabilimento (registrazione / riconoscimento)'),
      ],
    },
    {
      id: 'organic',
      label: 'Biologico e certificazioni',
      description: 'Biologico, SQNPI, marchi di qualità.',
      fields: [
        TEXT('body', 'Organismo di controllo', true),
        TEXT('schemes', 'Schemi o marchi (es. biologico, SQNPI)'),
      ],
    },
    {
      id: 'direct_sales',
      label: 'Vendita diretta',
      description: 'Spaccio, mercati, consegne, online.',
      fields: [TEXT('channels', 'Canali di vendita')],
    },
    {
      id: 'quota_sales',
      label: 'Vendita tramite Quota TerreFVG',
      description: 'Acquisti anticipati dei clienti tramite la rete.',
      fields: [TEXT('products', 'Prodotti offerti')],
    },
  ],
};

/** The questionnaire of a module; undefined when the sector has none yet. */
export function profileDefinitionOf(moduleId: string): CompanyProfileDefinition | undefined {
  return moduleId === 'agri' ? AGRI_PROFILE : undefined;
}
