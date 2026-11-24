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
  /**
   * Amounts written with their unit in the PDF (e.g. «30 tonnellate»): value field → choice field
   * of the unit. CSV and Excel keep them in two columns, for calculations.
   */
  units?: Readonly<Record<string, string>>;
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
    units: { quantity: 'unit' },
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
    units: { quantity: 'unit' },
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
    units: { quantity: 'unit' },
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

/** A person named in an entry (the participant of a course, a safety role…). */
const PERSON = (label: string): FieldDefinition => ({
  key: 'person',
  label,
  type: 'text',
  required: true,
  maxLength: 120,
});

const YEAR: FieldDefinition = {
  key: 'year',
  label: 'Anno',
  type: 'number',
  required: true,
  min: 2000,
  max: 2100,
};

/** Risk assessment (DVR, D.Lgs. 81/2008): its revisions and the people of the safety system. */
export const RISK_ASSESSMENT_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'revision',
    label: 'Redazione o revisione del DVR',
    titleFields: ['version', 'reason'],
    dateField: 'date',
    dueField: 'nextReview',
    deadlineCategory: 'SICUREZZA_LAVORO',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      {
        key: 'version',
        label: 'Versione o revisione',
        type: 'text',
        required: true,
        maxLength: 60,
      },
      {
        key: 'reason',
        label: 'Motivo',
        type: 'choice',
        options: [
          { value: 'first', label: 'Prima redazione' },
          { value: 'new_work', label: 'Nuove lavorazioni, macchine o sostanze' },
          { value: 'organization', label: 'Cambi organizzativi o di personale' },
          { value: 'accident', label: 'Infortunio o mancato infortunio' },
          { value: 'health', label: 'Esiti della sorveglianza sanitaria' },
          { value: 'periodic', label: 'Riesame periodico' },
        ],
      },
      { key: 'author', label: 'Redatto da', type: 'text', maxLength: 160 },
      { key: 'nextReview', label: 'Prossimo riesame', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'safety_role',
    label: 'Figura della sicurezza',
    titleFields: ['role', 'person'],
    dateField: 'appointedOn',
    fields: [
      {
        key: 'role',
        label: 'Ruolo',
        type: 'choice',
        required: true,
        options: [
          { value: 'employer', label: 'Datore di lavoro' },
          { value: 'rspp', label: 'RSPP' },
          { value: 'rls', label: 'RLS' },
          { value: 'doctor', label: 'Medico competente' },
          { value: 'supervisor', label: 'Preposto' },
          { value: 'first_aid', label: 'Addetto al primo soccorso' },
          { value: 'fire', label: 'Addetto antincendio' },
        ],
      },
      PERSON('Persona'),
      { key: 'appointedOn', label: 'Nominato il', type: 'date', required: true },
      NOTES,
    ],
  },
];

/** Farm file and CAP applications (paying agency, through the CAA). */
export const CAP_FILE_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'farm_file',
    label: 'Aggiornamento del fascicolo aziendale',
    titleFields: ['change', 'caa'],
    dateField: 'date',
    dueField: 'nextUpdate',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      { key: 'caa', label: 'CAA di riferimento', type: 'text', required: true, maxLength: 160 },
      { key: 'cuaa', label: 'CUAA', type: 'text', maxLength: 16 },
      {
        key: 'change',
        label: 'Variazione',
        type: 'choice',
        options: [
          { value: 'validation', label: 'Validazione annuale' },
          { value: 'land', label: 'Terreni e titoli di conduzione' },
          { value: 'crops', label: 'Piano colturale' },
          { value: 'livestock', label: 'Allevamenti' },
          { value: 'machinery', label: 'Macchine' },
          { value: 'company', label: 'Dati anagrafici o societari' },
        ],
      },
      { key: 'nextUpdate', label: 'Prossimo aggiornamento', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'application',
    label: 'Domanda PAC',
    titleFields: ['applicationType', 'year'],
    dateField: 'date',
    dueField: 'deadline',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      YEAR,
      {
        key: 'applicationType',
        label: 'Domanda',
        type: 'choice',
        required: true,
        options: [
          { value: 'single', label: 'Domanda unica' },
          { value: 'amendment', label: 'Domanda di modifica' },
          { value: 'withdrawal', label: 'Ritiro parziale o totale' },
          { value: 'rural', label: 'Misura a superficie dello sviluppo rurale' },
        ],
      },
      {
        key: 'status',
        label: 'Stato',
        type: 'choice',
        options: [
          { value: 'to_submit', label: 'Da presentare' },
          { value: 'submitted', label: 'Presentata' },
          { value: 'review', label: 'In istruttoria' },
          { value: 'paid', label: 'Pagata' },
        ],
      },
      { key: 'protocol', label: 'Numero di protocollo', type: 'text', maxLength: 60 },
      { key: 'deadline', label: 'Termine di presentazione', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'payment',
    label: 'Pagamento PAC ricevuto',
    titleFields: ['paymentType', 'year'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      YEAR,
      {
        key: 'paymentType',
        label: 'Pagamento',
        type: 'choice',
        required: true,
        options: [
          { value: 'advance', label: 'Anticipo' },
          { value: 'balance', label: 'Saldo' },
          { value: 'eco', label: 'Ecoschemi' },
          { value: 'coupled', label: 'Sostegno accoppiato' },
          { value: 'rural', label: 'Sviluppo rurale' },
          { value: 'other', label: 'Altro' },
        ],
      },
      { key: 'amount', label: 'Importo (€)', type: 'number', min: 0, max: 100_000_000 },
      NOTES,
    ],
  },
];

/** Subsidised farm fuel (UMA): yearly assignment and withdrawals. */
export const FARM_FUEL_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'assignment',
    label: 'Assegnazione UMA',
    titleFields: ['year'],
    dateField: 'date',
    dueField: 'reportDue',
    fields: [
      { key: 'date', label: 'Data di assegnazione', type: 'date', required: true },
      YEAR,
      { key: 'booklet', label: 'Numero del libretto', type: 'text', maxLength: 60 },
      { key: 'diesel', label: 'Gasolio assegnato (l)', type: 'number', min: 0, max: 10_000_000 },
      { key: 'petrol', label: 'Benzina assegnata (l)', type: 'number', min: 0, max: 10_000_000 },
      {
        key: 'carryOver',
        label: 'Rimanenza dell’anno prima (l)',
        type: 'number',
        min: 0,
        max: 10_000_000,
      },
      { key: 'reportDue', label: 'Termine per la dichiarazione dei consumi', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'withdrawal',
    label: 'Prelievo di carburante',
    titleFields: ['fuel', 'supplier'],
    dateField: 'date',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      {
        key: 'fuel',
        label: 'Carburante',
        type: 'choice',
        required: true,
        options: [
          { value: 'diesel', label: 'Gasolio' },
          { value: 'petrol', label: 'Benzina' },
        ],
      },
      { key: 'liters', label: 'Litri', type: 'number', required: true, min: 0, max: 1_000_000 },
      { key: 'supplier', label: 'Distributore', type: 'text', maxLength: 160 },
      { key: 'document', label: 'Fattura o DDT n.', type: 'text', maxLength: 60 },
      NOTES,
    ],
  },
];

/** Organic and quality certifications: certificates, inspections, yearly production plan. */
export const ORGANIC_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'certificate',
    label: 'Certificato',
    titleFields: ['scheme', 'body'],
    dateField: 'issuedOn',
    dueField: 'expiresOn',
    deadlineCategory: 'CERTIFICAZIONE_BIO',
    fields: [
      {
        key: 'scheme',
        label: 'Schema',
        type: 'choice',
        required: true,
        options: [
          { value: 'organic', label: 'Biologico (Reg. UE 2018/848)' },
          { value: 'sqnpi', label: 'Produzione integrata (SQNPI)' },
          { value: 'globalgap', label: 'GlobalG.A.P.' },
          { value: 'pdo_pgi', label: 'DOP / IGP' },
          { value: 'other', label: 'Altro' },
        ],
      },
      {
        key: 'body',
        label: 'Organismo di controllo',
        type: 'text',
        required: true,
        maxLength: 160,
      },
      { key: 'number', label: 'Numero', type: 'text', maxLength: 60 },
      { key: 'products', label: 'Prodotti certificati', type: 'text', maxLength: 300 },
      { key: 'issuedOn', label: 'Data di rilascio', type: 'date', required: true },
      { key: 'expiresOn', label: 'Scadenza', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'inspection',
    label: 'Visita ispettiva',
    titleFields: ['body', 'outcome'],
    dateField: 'date',
    dueField: 'correctiveDue',
    deadlineCategory: 'CERTIFICAZIONE_BIO',
    fields: [
      { key: 'date', label: 'Data', type: 'date', required: true },
      {
        key: 'body',
        label: 'Organismo di controllo',
        type: 'text',
        required: true,
        maxLength: 160,
      },
      {
        key: 'outcome',
        label: 'Esito',
        type: 'choice',
        options: [
          { value: 'compliant', label: 'Conforme' },
          { value: 'minor', label: 'Non conformità lievi' },
          { value: 'major', label: 'Non conformità gravi' },
          { value: 'pending', label: 'In attesa del verbale' },
        ],
      },
      { key: 'findings', label: 'Rilievi', type: 'text', maxLength: 1000 },
      { key: 'correctiveDue', label: 'Termine delle azioni correttive', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'production_plan',
    label: 'Programma annuale di produzione (PAP)',
    titleFields: ['year'],
    dateField: 'date',
    dueField: 'nextDue',
    deadlineCategory: 'CERTIFICAZIONE_BIO',
    fields: [
      { key: 'date', label: 'Data di presentazione', type: 'date', required: true },
      YEAR,
      { key: 'nextDue', label: 'Termine del prossimo programma', type: 'date' },
      NOTES,
    ],
  },
];

/** Mandatory training, health checks and protective equipment, person by person. */
export const TRAINING_RECORDS: readonly SectorRecordKind[] = [
  {
    kind: 'course',
    label: 'Corso di formazione',
    titleFields: ['course', 'person'],
    dateField: 'completedOn',
    dueField: 'expiresOn',
    deadlineCategory: 'SICUREZZA_LAVORO',
    fields: [
      PERSON('Partecipante'),
      {
        key: 'course',
        label: 'Corso',
        type: 'choice',
        required: true,
        options: [
          { value: 'general', label: 'Formazione generale lavoratori' },
          { value: 'specific', label: 'Formazione specifica lavoratori' },
          { value: 'supervisor', label: 'Preposto' },
          { value: 'employer_rspp', label: 'Datore di lavoro RSPP' },
          { value: 'rls', label: 'RLS' },
          { value: 'first_aid', label: 'Primo soccorso' },
          { value: 'fire', label: 'Antincendio' },
          { value: 'refresher', label: 'Aggiornamento' },
          { value: 'other', label: 'Altro' },
        ],
      },
      { key: 'hours', label: 'Ore', type: 'number', min: 0, max: 1000 },
      { key: 'provider', label: 'Ente di formazione', type: 'text', maxLength: 160 },
      { key: 'completedOn', label: 'Completato il', type: 'date', required: true },
      { key: 'expiresOn', label: 'Scadenza dell’aggiornamento', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'medical_check',
    label: 'Visita medica',
    titleFields: ['person', 'outcome'],
    dateField: 'date',
    dueField: 'nextVisit',
    deadlineCategory: 'VISITA_MEDICA',
    fields: [
      PERSON('Lavoratore'),
      { key: 'date', label: 'Data', type: 'date', required: true },
      {
        key: 'outcome',
        label: 'Giudizio',
        type: 'choice',
        options: [
          { value: 'fit', label: 'Idoneo' },
          { value: 'fit_limits', label: 'Idoneo con prescrizioni o limitazioni' },
          { value: 'unfit_temporary', label: 'Non idoneo temporaneamente' },
          { value: 'unfit', label: 'Non idoneo' },
        ],
      },
      { key: 'nextVisit', label: 'Prossima visita', type: 'date' },
      NOTES,
    ],
  },
  {
    kind: 'ppe',
    label: 'Consegna di DPI',
    titleFields: ['items', 'person'],
    dateField: 'date',
    fields: [
      PERSON('Lavoratore'),
      { key: 'date', label: 'Data', type: 'date', required: true },
      {
        key: 'items',
        label: 'Dispositivi consegnati',
        type: 'text',
        required: true,
        maxLength: 300,
      },
      NOTES,
    ],
  },
];
