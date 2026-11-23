import type { FieldDefinition } from '../core/modules/module.contract.js';
import type { ComplianceCategory } from '@prisma/client';

/**
 * Data, like the modules: what the register of each function of a sector holds.
 *
 * A function that is built has one or more kinds of entry (a treatment, a harvest, a licence…),
 * each with its fields. The fields reuse the practice fields (text, number, date, choice) and
 * are validated the same way: what is stored is only what is declared here.
 *
 * The content is a first version, to be checked with the pilot organizations (AGX-09).
 */
export type SectorRecordKind = {
  /** Stable identifier stored with the entry (`sector_record.kind`). */
  kind: string;
  /** Italian label for people. */
  label: string;
  fields: readonly FieldDefinition[];
  /** The fields that make the title of an entry, joined with « · » (choices by their label). */
  titleFields: readonly string[];
  /** A date field: when it happened, for the order of the register. */
  dateField?: string;
  /**
   * A date field that is an expiry: the entry gets a deadline of the organization in this
   * category, with the usual reminders, kept in step with the entry.
   */
  dueField?: string;
  deadlineCategory?: ComplianceCategory;
};

const NOTES: FieldDefinition = { key: 'notes', label: 'Note', type: 'text', maxLength: 1000 };

const PLOT: FieldDefinition = {
  key: 'plot',
  label: 'Appezzamento',
  type: 'text',
  required: true,
  maxLength: 120,
};
const CROP: FieldDefinition = {
  key: 'crop',
  label: 'Coltura',
  type: 'text',
  required: true,
  maxLength: 120,
};
const AREA: FieldDefinition = {
  key: 'area',
  label: 'Superficie (ha)',
  type: 'number',
  min: 0,
  max: 100_000,
};

const AMOUNT_UNITS = [
  { value: 'kg_ha', label: 'kg/ha' },
  { value: 'l_ha', label: 'l/ha' },
  { value: 'kg', label: 'kg' },
  { value: 'l', label: 'l' },
  { value: 'q', label: 'quintali' },
  { value: 't', label: 'tonnellate' },
] as const;

/** Quaderno di campagna: treatments, fertilizations and harvests per plot. */
export const FIELD_BOOK_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'treatment',
    label: 'Trattamento fitosanitario',
    titleFields: ['product', 'crop'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      PLOT,
      CROP,
      {
        key: 'product',
        label: 'Prodotto commerciale',
        type: 'text',
        required: true,
        maxLength: 160,
      },
      { key: 'quantity', label: 'Quantità', type: 'number', min: 0, max: 1_000_000 },
      { key: 'unit', label: 'Unità', type: 'choice', options: AMOUNT_UNITS },
      AREA,
      { key: 'target', label: 'Avversità', type: 'text', maxLength: 160 },
      { key: 'operator', label: 'Operatore', type: 'text', maxLength: 120 },
      NOTES,
    ],
  },
  {
    kind: 'fertilization',
    label: 'Concimazione',
    titleFields: ['product', 'crop'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      PLOT,
      CROP,
      { key: 'product', label: 'Concime', type: 'text', required: true, maxLength: 160 },
      { key: 'quantity', label: 'Quantità', type: 'number', min: 0, max: 1_000_000 },
      { key: 'unit', label: 'Unità', type: 'choice', options: AMOUNT_UNITS },
      AREA,
      NOTES,
    ],
  },
  {
    kind: 'harvest',
    label: 'Raccolta',
    titleFields: ['crop', 'plot'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      PLOT,
      CROP,
      { key: 'quantity', label: 'Quantità', type: 'number', min: 0, max: 1_000_000 },
      { key: 'unit', label: 'Unità', type: 'choice', options: AMOUNT_UNITS },
      NOTES,
    ],
  },
];

/** Abilitazioni e patentini: one entry per licence of a person, with its renewal. */
export const LICENSE_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'license',
    label: 'Abilitazione o patentino',
    titleFields: ['licenseType', 'holder'],
    dateField: 'issuedOn',
    dueField: 'expiresOn',
    deadlineCategory: 'PATENTINO',
    fields: [
      { key: 'holder', label: 'Titolare', type: 'text', required: true, maxLength: 120 },
      {
        key: 'licenseType',
        label: 'Tipo',
        type: 'choice',
        required: true,
        options: [
          { value: 'plant_protection', label: 'Patentino prodotti fitosanitari' },
          { value: 'tractor', label: 'Abilitazione trattori' },
          { value: 'forklift', label: 'Carrelli elevatori' },
          { value: 'earthmoving', label: 'Macchine movimento terra' },
          { value: 'f_gas', label: 'Certificazione F-gas' },
          { value: 'electrical', label: 'Lavori elettrici (PES/PAV)' },
          { value: 'installer', label: 'Abilitazione impianti' },
          { value: 'other', label: 'Altra abilitazione' },
        ],
      },
      { key: 'number', label: 'Numero', type: 'text', maxLength: 60 },
      { key: 'issuer', label: 'Rilasciato da', type: 'text', maxLength: 160 },
      { key: 'issuedOn', label: 'Data di rilascio', type: 'date' },
      { key: 'expiresOn', label: 'Scadenza', type: 'date' },
      NOTES,
    ],
  },
];
