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
  mine: true,
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
    items,
    page: 1,
    limit: 20,
    total: items.length,
    totalPages: 1,
  };
}
