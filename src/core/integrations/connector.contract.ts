/**
 * A06: the standard contract of an ERP/CRM connector (design only: no connector is built yet).
 * The first candidate is Odoo for TerreFVG (A07–A10), only after the pilot confirms it and gives
 * a test instance. See docs/FASE1_CORE_E_MODULI.md §5.
 *
 * Rules every connector follows:
 * - it works for one organization at a time, and only when the platform turned its integration
 *   on for that organization;
 * - it never receives SinfonIA credentials, and its own ones live in the secret manager, referred
 *   to by name (`credentialsRef`), never in the database or in logs;
 * - what comes in is mapped to SinfonIA objects through the organization's module and checked
 *   like any other input (fields, kinds, deadline categories); nothing writes to the database
 *   directly;
 * - every exchange is idempotent (`externalRef` + `version`) and recorded in the audit log of
 *   the organization; a failure never blocks the rest of SinfonIA (it is retried from the outbox);
 * - it reads only what its declared capabilities allow, and writes back only states, never
 *   documents or personal data beyond what the delegation or the organization allows.
 */

export type ConnectorCapability =
  /** Reads the companies of a network (name, VAT number, municipality, sector). */
  | 'companies.read'
  /** Reads people of a company to invite them (never imported as accounts). */
  | 'contacts.read'
  /** Reads procedures or deadlines that become practices or deadlines in SinfonIA. */
  | 'practices.read'
  /** Sends back the state of a practice when it changes. */
  | 'practices.status.write';

export type ConnectorDefinition = {
  /** Stable id, e.g. `odoo`. */
  id: string;
  label: string;
  capabilities: readonly ConnectorCapability[];
  /** Sync from the external system: on a schedule, on its webhook, or both. */
  trigger: 'schedule' | 'webhook' | 'both';
};

/** The configuration of a connector for one organization (no secret values). */
export type ConnectorSettings = {
  orgId: string;
  connectorId: string;
  /** Base address of the external system, HTTPS only. */
  baseUrl: string;
  /** Name of the secret in the secret manager. */
  credentialsRef: string;
  enabledCapabilities: readonly ConnectorCapability[];
};

/** An object of the external system, as the connector maps it before SinfonIA checks it. */
export type ExternalRecord<T> = {
  /** Identifier in the external system, unique for the connector and the organization. */
  externalRef: string;
  /** Version or last change in the external system: an older one is ignored. */
  version: string;
  data: T;
};

export type ExternalCompany = {
  name: string;
  vatNumber?: string;
  municipality?: string;
  sector?: string;
};

export type ExternalPractice = {
  name: string;
  /** A kind of the organization's module; anything else is refused. */
  kind: string;
  fields?: Record<string, unknown>;
  dueDate?: string;
};

export type ConnectorHealth = { ok: boolean; checkedAt: Date; detail?: string };

/** What a connector implements; optional methods follow its declared capabilities. */
export interface ErpCrmConnector {
  readonly definition: ConnectorDefinition;
  healthCheck(settings: ConnectorSettings): Promise<ConnectorHealth>;
  /** Changes since the last cursor; returns the cursor to store for the next call. */
  pullCompanies?(
    settings: ConnectorSettings,
    cursor: string | null,
  ): Promise<{ items: Array<ExternalRecord<ExternalCompany>>; cursor: string | null }>;
  pullPractices?(
    settings: ConnectorSettings,
    cursor: string | null,
  ): Promise<{ items: Array<ExternalRecord<ExternalPractice>>; cursor: string | null }>;
  pushPracticeStatus?(
    settings: ConnectorSettings,
    input: { externalRef: string; status: string; changedAt: Date },
  ): Promise<void>;
}
