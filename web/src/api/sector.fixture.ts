/** A register of the Quaderno di campagna as the server returns it, for the tests. */
import type { SectorRecord, SectorRegisterPage } from './sector';

const PLOT = { key: 'plot', label: 'Appezzamento', type: 'text', required: true } as const;
const CROP = { key: 'crop', label: 'Coltura', type: 'text', required: true } as const;

export const FIELD_BOOK_KINDS: SectorRegisterPage['kinds'] = [
  {
    kind: 'treatment',
    label: 'Trattamento fitosanitario',
    titleFields: ['product', 'crop'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      PLOT,
      CROP,
      { key: 'product', label: 'Prodotto commerciale', type: 'text', required: true },
      { key: 'quantity', label: 'Quantità', type: 'number', min: 0 },
      {
        key: 'unit',
        label: 'Unità',
        type: 'choice',
        options: [
          { value: 'kg_ha', label: 'kg/ha' },
          { value: 'l_ha', label: 'l/ha' },
        ],
      },
      { key: 'notes', label: 'Note', type: 'text', maxLength: 1000 },
    ],
  },
  {
    kind: 'harvest',
    label: 'Raccolta',
    titleFields: ['crop', 'plot'],
    dateField: 'date',
    fields: [{ key: 'date', label: 'Data', type: 'date', required: true }, PLOT, CROP],
  },
];

export const TREATMENT: SectorRecord = {
  id: 'r0000000-0000-4000-8000-000000000001',
  feature: 'field_book',
  kind: 'treatment',
  kindLabel: 'Trattamento fitosanitario',
  title: 'Rame · Vite',
  data: {
    date: '2026-11-20',
    plot: 'Vigna nord',
    crop: 'Vite',
    product: 'Rame',
    quantity: 2.5,
    unit: 'kg_ha',
  },
  occurredOn: '2026-11-20',
  dueDate: null,
  daysLeft: null,
  author: { id: 'u-1', email: 'anna@collio.it' },
  notify: null,
  mine: true,
  attachments: [],
  createdAt: '2026-11-20T08:00:00.000Z',
  updatedAt: '2026-11-20T08:00:00.000Z',
};

export function fieldBookPage(
  items: SectorRecord[] = [TREATMENT],
  canManage = true,
): SectorRegisterPage {
  return {
    feature: {
      id: 'field_book',
      label: 'Quaderno di campagna',
      description: 'Registro dei trattamenti e delle lavorazioni.',
    },
    kinds: FIELD_BOOK_KINDS,
    canManage,
    people: [],
    items,
    page: 1,
    limit: 20,
    total: items.length,
    totalPages: 1,
  };
}

/** A register of licences, whose expiry can name a person of the organization to remind. */
export const LICENSE_KIND: SectorRegisterPage['kinds'][number] = {
  kind: 'license',
  label: 'Abilitazione o patentino',
  titleFields: ['licenseType', 'holder'],
  dateField: 'issuedOn',
  dueField: 'expiresOn',
  notify: 'Persona da avvisare in SinfonIA',
  fields: [
    { key: 'holder', label: 'Titolare', type: 'text', required: true },
    {
      key: 'licenseType',
      label: 'Tipo',
      type: 'choice',
      required: true,
      options: [{ value: 'plant_protection', label: 'Patentino prodotti fitosanitari' }],
    },
    { key: 'expiresOn', label: 'Scadenza', type: 'date' },
  ],
};

export const LICENSE: SectorRecord = {
  ...TREATMENT,
  id: 'r0000000-0000-4000-8000-000000000002',
  feature: 'trade_licenses',
  kind: 'license',
  kindLabel: 'Abilitazione o patentino',
  title: 'Patentino prodotti fitosanitari · Marco T.',
  data: {
    holder: 'Marco T.',
    licenseType: 'plant_protection',
    expiresOn: '2026-12-18',
    notify: 'u-2',
  },
  occurredOn: null,
  dueDate: '2026-12-18',
  daysLeft: 24,
  notify: { id: 'u-2', label: 'marco@collio.it' },
};

export function licensePage(items: SectorRecord[] = [LICENSE]): SectorRegisterPage {
  return {
    ...fieldBookPage(items),
    feature: {
      id: 'trade_licenses',
      label: 'Abilitazioni e patentini',
      description: 'Patentini e abilitazioni delle persone.',
    },
    kinds: [LICENSE_KIND],
    people: [
      { id: 'u-1', label: 'anna@collio.it' },
      { id: 'u-2', label: 'marco@collio.it' },
    ],
  };
}
