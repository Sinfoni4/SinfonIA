import { GENERIC_PRACTICE } from './generic.module.js';

import type { VerticalModule } from '../core/modules/module.contract.js';

/** Agricultural companies and their networks (pilot TerreFVG). */
export const AGRI_MODULE: VerticalModule = {
  id: 'agri',
  label: 'Agricoltura',
  description: 'Aziende agricole e reti: domande, certificazioni e adempimenti.',
  defaultKind: 'agri',
  practiceTypes: [
    GENERIC_PRACTICE,
    {
      kind: 'agri',
      label: 'Agricola',
      typeLabel: 'agricultural practice',
      summaryPrefix: 'pratica agricola',
      fields: [
        {
          key: 'procedure',
          label: 'Procedimento',
          type: 'choice',
          options: [
            { value: 'pac', label: 'Domanda PAC' },
            { value: 'csr', label: 'Bando di sviluppo rurale' },
            { value: 'organic', label: 'Certificazione biologica' },
            { value: 'other', label: 'Altro' },
          ],
        },
        { key: 'campaignYear', label: 'Anno della campagna', type: 'number', min: 2000, max: 2100 },
        { key: 'dueDate', label: 'Termine di presentazione', type: 'date' },
      ],
      subStates: [
        { key: 'collecting_documents', label: 'Raccolta documenti', during: ['CREATED'] },
        { key: 'under_review', label: 'In istruttoria', during: ['SUBMITTED'] },
        { key: 'integration_requested', label: 'Integrazione richiesta', during: ['SUBMITTED'] },
      ],
      expectedDocuments: [
        { key: 'farm_file', label: 'Fascicolo aziendale aggiornato', required: true },
        { key: 'identity', label: "Documento d'identità del titolare", required: true },
        { key: 'chamber_record', label: 'Visura camerale', required: false },
        {
          key: 'organic_certificate',
          label: 'Certificato biologico',
          required: false,
          deadlineCategory: 'CERTIFICAZIONE_BIO',
        },
      ],
    },
  ],
  deadlineCategories: [
    'DURC',
    'SICUREZZA_LAVORO',
    'CERTIFICAZIONE_BIO',
    'VISITA_MEDICA',
    'PATENTINO',
    'ALTRO',
  ],
  aiInstructions:
    'Settore: aziende agricole e reti di imprese agricole. Le pratiche riguardano domande PAC, ' +
    'bandi di sviluppo rurale, certificazioni biologiche e adempimenti; il nome della pratica è ' +
    "di solito il procedimento o l'azienda.",
  welcome: '🌾 Benvenuto! Sei stato collegato alla tua organizzazione.',
};
