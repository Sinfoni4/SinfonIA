import { GENERIC_PRACTICE } from './generic.module.js';

import type { VerticalModule } from '../core/modules/module.contract.js';

/** Craft businesses and their trade associations (e.g. Confartigianato). */
export const ARTISAN_MODULE: VerticalModule = {
  id: 'artisan',
  label: 'Artigianato',
  description:
    'Imprese artigiane e associazioni di categoria: abilitazioni, formazione e pratiche.',
  defaultKind: 'artisan',
  practiceTypes: [
    GENERIC_PRACTICE,
    {
      kind: 'artisan',
      label: 'Artigiana',
      typeLabel: 'craft business practice',
      summaryPrefix: 'pratica artigiana',
      fields: [
        {
          key: 'procedure',
          label: 'Procedimento',
          type: 'choice',
          options: [
            { value: 'startup', label: 'Avvio o variazione d’impresa' },
            { value: 'license', label: 'Abilitazione o patentino' },
            { value: 'training', label: 'Formazione obbligatoria' },
            { value: 'grant', label: 'Bando o contributo' },
            { value: 'waste', label: 'Rifiuti e ambiente' },
            { value: 'other', label: 'Altro' },
          ],
        },
        { key: 'dueDate', label: 'Termine di presentazione', type: 'date' },
      ],
      subStates: [
        { key: 'collecting_documents', label: 'Raccolta documenti', during: ['CREATED'] },
        { key: 'under_review', label: 'In istruttoria', during: ['SUBMITTED'] },
        { key: 'integration_requested', label: 'Integrazione richiesta', during: ['SUBMITTED'] },
      ],
      expectedDocuments: [
        { key: 'identity', label: "Documento d'identità del titolare", required: true },
        { key: 'chamber_record', label: 'Visura camerale', required: false },
        { key: 'durc', label: 'DURC', required: false, deadlineCategory: 'DURC' },
      ],
    },
  ],
  deadlineCategories: ['DURC', 'SICUREZZA_LAVORO', 'VISITA_MEDICA', 'PATENTINO', 'ALTRO'],
  aiInstructions:
    'Settore: imprese artigiane e associazioni di categoria. Le pratiche riguardano avvio e ' +
    'variazioni d’impresa, abilitazioni e patentini, formazione obbligatoria, bandi e rifiuti; ' +
    "il nome della pratica è di solito il procedimento o l'impresa.",
  welcome: '🛠️ Benvenuto! Sei stato collegato alla tua organizzazione.',
};
