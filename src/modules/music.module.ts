import { GENERIC_PRACTICE } from './generic.module.js';

import type { VerticalModule } from '../core/modules/module.contract.js';

/** Music cooperatives: the sector SinfonIA started from. */
export const MUSIC_MODULE: VerticalModule = {
  id: 'music',
  label: 'Musica e spettacolo',
  description: 'Cooperative di artisti: pratiche per artisti ed eventi.',
  defaultKind: 'music',
  practiceTypes: [
    GENERIC_PRACTICE,
    {
      kind: 'music',
      label: 'Musicale',
      typeLabel: 'music practice',
      summaryPrefix: 'pratica music',
      fields: [
        { key: 'eventDate', label: "Data dell'evento", type: 'date' },
        { key: 'venue', label: 'Luogo', type: 'text', maxLength: 200 },
      ],
      subStates: [
        {
          key: 'contract_to_sign',
          label: 'Contratto da firmare',
          during: ['CREATED', 'VALIDATED'],
        },
        { key: 'awaiting_payment', label: 'In attesa del pagamento', during: ['SUBMITTED'] },
      ],
      expectedDocuments: [
        { key: 'contract', label: 'Contratto di scrittura', required: true },
        { key: 'agibility', label: 'Certificato di agibilità', required: false },
      ],
    },
    {
      kind: 'artist',
      label: 'Artista',
      typeLabel: 'artist practice',
      summaryPrefix: 'pratica artista',
      fields: [{ key: 'stageName', label: "Nome d'arte", type: 'text', maxLength: 120 }],
      subStates: [],
      expectedDocuments: [{ key: 'identity', label: "Documento d'identità", required: true }],
    },
  ],
  deadlineCategories: ['DURC', 'SICUREZZA_LAVORO', 'VISITA_MEDICA', 'ALTRO'],
  aiInstructions:
    'Settore: cooperativa di musica e spettacolo. Le pratiche riguardano artisti, eventi e ' +
    "contratti di scrittura; il nome della pratica è di solito il nome dell'artista o dell'evento.",
  welcome: '🎵 Benvenuto! Sei stato collegato alla tua cooperativa.',
};
