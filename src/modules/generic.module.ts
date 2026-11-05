import type { PracticeTypeDefinition, VerticalModule } from '../core/modules/module.contract.js';

/** The practice every organization can use, whatever its sector. */
export const GENERIC_PRACTICE: PracticeTypeDefinition = {
  kind: 'generic',
  label: 'Generica',
  typeLabel: 'generic practice',
  summaryPrefix: 'pratica',
  fields: [
    { key: 'reference', label: 'Riferimento', type: 'text', maxLength: 100 },
    { key: 'notes', label: 'Note', type: 'text', maxLength: 1000 },
  ],
  subStates: [],
  expectedDocuments: [],
};

export const GENERIC_MODULE: VerticalModule = {
  id: 'generic',
  label: 'Generico',
  description: 'Pratiche e scadenze senza un settore specifico.',
  defaultKind: 'generic',
  practiceTypes: [GENERIC_PRACTICE],
  deadlineCategories: [
    'DURC',
    'SICUREZZA_LAVORO',
    'CERTIFICAZIONE_BIO',
    'VISITA_MEDICA',
    'PATENTINO',
    'ALTRO',
  ],
  aiInstructions: '',
  welcome: '👋 Benvenuto! Sei stato collegato alla tua organizzazione.',
};
