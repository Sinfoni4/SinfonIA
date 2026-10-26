# SinfonIA — Documentazione e Report di Implementazione Fasi 1 e 2

**Repository Git**: `https://github.com/Sinfoni4/SinfonIA`  
**Progetto**: SinfonIA — Core Orchestration, Tenant Isolation & Practice Workflow Engine  
**Versione Schema Prisma**: PostgreSQL 17+ con Prisma v7 Driver Adapter (`@prisma/adapter-pg`)

---

## 1. Visione d'Insieme & Obiettivi

L'intervento architetturale e ingegneristico sulle **Fasi 1 e 2** ha trasformato il sistema da un prototipo con logica in-memory e vincoli ad-hoc a una piattaforma **enterprise multi-tenant**, **schema-driven**, **durevole** e **concorrenzialmente sicura**.

### Matrice di Sintesi delle Fasi

| Fase        | Titolo                      | Obiettivo Primario                          | Risultato Chiave                                                                                     |
| :---------- | :-------------------------- | :------------------------------------------ | :--------------------------------------------------------------------------------------------------- |
| **Fase 1A** | Isolamento Multi-Tenant     | Separazione logica e fisica dati per tenant | Foreign key obbligatorie, Trigger PostgreSQL per coerenza `user_id`/`tenant_id`                      |
| **Fase 1B** | Autenticazione & RBAC       | Controllo accessi crittografico e ruoli     | Token JWT HS256, guardie Fastify per ruoli `ADMIN`, `OPERATOR`, `MEMBER`                             |
| **Fase 1C** | Sicurezza Canale Telegram   | Robustezza bot e sanitizzazione PII         | Telegram Client sicuro, isolamento identità chat, rimozione token/PII dai log                        |
| **Fase 1D** | Tooling & Provisioning      | Gestione operativa e automazione chiavi     | CLI `tenant.provision.ts` e `auth.token.ts`, test di sicurezza ed isolamento                         |
| **Fase 2A** | Dominio Canonico Pratiche   | Disaccoppiamento dai moduli specifici       | Modello `Practice` unificato, workflow di stato deterministico, `PracticeApplicationService`         |
| **Fase 2B** | JSONB Payload & REST APIs   | Estendibilità semantica e query performanti | Indici GIN su `payload`, API CRUD/ricerca/export, paginazione e ordinamento                          |
| **Fase 2C** | Scheduler Durevole & Outbox | Resilienza ai riavvii e no burst            | Persistenza in `scheduler_job`/`scheduler_run`, Advisory Lock PostgreSQL, tabella `outbox_message`   |
| **Fase 2D** | Gate di Validazione Finale  | Garanzia di robustezza concorrente e parità | 4 Gate automatici: riavvio senza burst, concorrenza multi-worker, parità HTTP/TG, EXPLAIN query plan |

---

## 2. Fase 1: Tenant Isolation, Autenticazione & Sicurezza

### Step 1A: Architettura Multi-Tenant & Trigger di Coerenza nel Database

- **Schema Prisma & Database Relazionale**:
  - Aggiunta della colonna `tenant_id` su tutte le tabelle applicative primarie: `user`, `practice`, `audit_log`, `telegram_identity`.
  - Creazione di indici compositi di isolamento: `[tenant_id, id]`, `[tenant_id, status]`, `[tenant_id, email]`.
- **Integrità Referenziale a Livello Database**:
  - Implementazione dei trigger PostgreSQL `trg_enforce_practice_user_tenant` e `trg_enforce_audit_user_tenant`:
  - Se una query tenta di inserire o modificare una pratica o un audit log con un `user_id` appartenente a un tenant diverso dal `tenant_id` specificato, PostgreSQL genera un'eccezione `P0001` bloccando la transazione alla radice.

### Step 1B: Autenticazione Bearer HS256 & Route Guards RBAC

- **Autenticazione Stateless JWT (HS256)**:
  - Firma e verifica di token simmetrici con claims standard (`sub`, `tenant_id`, `role`, `iss`, `aud`, `exp`).
  - Pre-handler Fastify (`requireAuth`) che estrae il token dall'header `Authorization: Bearer <token>`, valida la firma, verifica scadenza e audience, ed inietta `request.authContext = { userId, tenantId, role }`.
- **Controllo degli Accessi Basato sui Ruoli (RBAC)**:
  - Definizione dell'enum dei ruoli: `ADMIN`, `OPERATOR`, `MEMBER`.
  - Guardia `requireRole(['ADMIN', 'OPERATOR'])` per operazioni sensibili (es. transizioni di stato e configurazioni tenant).
  - Rotte pubbliche ristrette esclusivamente agli health check (`/healthz`, `/readyz`).

### Step 1C: Hardening Telegram Bot & Sanitizzazione Log PII

- **Rimozione Dipendenze Vulnerabili**:
  - Sostituzione di librerie deprecate o non sicure con client HTTP moderno e testabile.
  - Binding sicuro dell'identità Telegram: mapping deterministico `telegram_id -> user_id -> tenant_id` salvato su PostgreSQL nella tabella `telegram_identity`.
- **Sanitizzazione PII nei Log**:
  - Pino logger configurato per offuscare automaticamente token Telegram, bearer token, email e payload sensibili dai log operativi.

### Step 1D: Tooling Operativo & Script CLI

- **`scripts/tenant.provision.ts`**: Script per il provisioning rapido di tenant, con creazione automatica dell'utente amministratore predefinito.
- **`scripts/auth.token.ts`**: CLI per emettere token JWT con claim personalizzati, durata configurabile e ruoli per testing o integrazioni esterne.
- **Suite di Test Fase 1**: Test dedicati (`tests/auth.test.ts`, `tests/data.test.ts`) che verificano la totale non-permeabilità dei dati tra tenant differenti.

---

## 3. Fase 2: Canonical Practice Domain, REST API, Scheduler Durevole & Gate

### Step 2A: Dominio Canonico della Pratica & Workflow

- **Disaccoppiamento del Dominio**:
  - Rimozione completa delle entità accoppiate al solo ambito musicale (`ArtistPractice`, `music.module.ts`, ecc.).
  - Introduzione del modello canonico unificato `Practice` con:
    - `id` (UUID), `tenant_id` (UUID), `user_id` (UUID)
    - `name` (String), `kind` (String, es. `generic`, `music`, `legal`, `fiscal`)
    - `status`: ciclo di vita FSM deterministico (`CREATED` $\rightarrow$ `VALIDATED` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `COMPLETED`, con fallback `REJECTED`)
    - `version`: lock ottimistico contro aggiornamenti concorrenti
    - `schema_version`: evoluzione dello schema dei dati
- **Command Parser Deterministico**:
  - `src/core/practice/practice.commands.ts`: parser deterministico per comandi impartiti via linguaggio naturale o chat Telegram (`crea pratica <nome>`, `stato pratica <nome>`, `export pratiche <filtro>`).

### Step 2B: Payload JSONB, Indici GIN & API REST

- **Payload Schema & Storage Dinamico**:
  - Integrazione di `payload` JSONB tipizzato (`PracticePayload`) con discriminatore `type` (`generic_practice`, `music_practice`, estensibile ad altri domini).
  - Aggiunta della migrazione `20261026140000_phase2b_payload_gin_index` che crea l'indice GIN:
    ```sql
    CREATE INDEX "practice_tenant_id_payload_gin_idx"
    ON "practice" USING GIN ("tenant_id", "payload");
    ```
- **Nuove Rotte REST Protette**:
  - `POST /practices`: creazione pratica associata al tenant e all'utente autenticato.
  - `GET /practices`: lista paginata con supporto a ricerca libera su testo (`search`), filtro per `status`, paginazione (`page`, `limit`) e ordinamento (`sortBy`, `sortOrder`).
  - `GET /practices/:id`: lettura puntuale con verifica automatica dell'appartenenza al tenant.
  - `POST /practices/export`: esportazione in formato CSV (con filtri per data/periodo: `all`, `today`, `month`, `year`).

### Step 2C: Scheduler Durevole, PostgreSQL Advisory Locks & Outbox Pattern

- **Persistenza & Idempotenza dei Job**:
  - Schema esteso con le tabelle `scheduler_job` e `scheduler_run`.
  - Generazione dell'idempotency key deterministica:
    $$\text{idempotencyKey} = \text{tenantId} : \text{taskType} : \text{frequency} : \text{periodKey}$$
    (Es. `01ebe...:EXPORT_PRACTICES:daily:2026-10-26`).
  - Vincolo `UNIQUE ("idempotency_key")` a livello database PostgreSQL per impedire doppie esecuzioni.
- **PostgreSQL Session Advisory Locks**:
  - Utilizzo di `pg_try_advisory_lock(hashtext(lockKey))` per garantire mutua esclusione non-bloccante tra più istanze di worker paralleli.
  - Se un worker acquisisce il lock, esegue il job; altri worker che tentano di processare lo stesso task per lo stesso tenant rilevano il lock occupato e saltano l'esecuzione senza generare conflitti o duplicati.
- **Pattern Outbox Transazionale**:
  - Tabella `outbox_message` con stato `PENDING` $\rightarrow$ `SENT` $\rightarrow$ `FAILED`.
  - Gli artefatti generati (es. export CSV) vengono scritti nella tabella outbox, garantendo affidabilità e consistenza event-driven.
- **Eliminazione del Burst al Boot**:
  - Lo scheduler non memorizza più timer in memoria volatile. Al riavvio dell'applicazione (`tick`), interroga la tabella `scheduler_run`: se il periodo corrente risulta già `COMPLETED`, il task viene saltato (`skippedCount: 1, triggeredCount: 0`).

---

## 4. Dettaglio Implementativo Fase 2D (Gate di Validazione Finale)

Il Gate 2D ha validato tramite test automatici e analisi formale delle query le 4 condizioni critiche di resilienza ed equivalenza:

### Gate 1: Test di Riavvio e Zero-Burst all'Avvio

- **File**: `tests/gate.phase2.test.ts` (`Gate 1: Restart preserves data integrity and prevents export burst on boot`)
- **Procedura**:
  1. Creazione di un tenant con scheduler abilitato e di una pratica associata.
  2. Esecuzione del primo ciclo dello scheduler (`schedulerA.tick()`): `triggeredCount = 1`, job registrato su DB.
  3. Simulazione dell'arresto completo del processo (`serviceA = null; schedulerA = null`).
  4. Riavvio da zero con nuove istanze (`serviceB`, `schedulerB`).
  5. Verifica che i dati e la pratica siano intatti (`schemaVersion: 1`, payload preservato).
  6. Esecuzione del tick post-reboot al medesimo timestamp: `triggeredCount = 0`, `skippedCount = 1`.
- **Esito**: **PASSED**. Zero burst all'avvio, idempotenza garantita.

### Gate 2: Concorrenza Multi-Worker (Advisory Lock) e Zero Export Duplicati

- **File**: `tests/gate.phase2.test.ts` (`Gate 2: Dual concurrent workers produce zero duplicate exports (Advisory Lock)`)
- **Procedura**:
  1. Istanziazione contemporanea di due worker indipendenti (`worker1`, `worker2`), ciascuno con la propria connessione Prisma al database PostgreSQL.
  2. Lancio concorrente simultaneo tramite `Promise.all([worker1.tick(), worker2.tick()])`.
  3. Verifica del lock advisory PostgreSQL: esattamente 1 worker acquisisce il lock e completa l'esecuzione (`totalTriggered: 1`), l'altro fallisce l'acquisizione e termina no-op (`totalSkipped: 1`).
  4. Verifica che la funzione di export sia stata invocata esattamente 1 sola volta (`totalExportCalls: 1`).
  5. Verifica che nella tabella `outbox_message` sia presente un solo record per l'evento generato.
- **Esito**: **PASSED**. Concorrenza multi-worker sicura al 100%.

### Gate 3: Equivalenza Funzionale HTTP vs Telegram

- **File**: `tests/gate.phase2.test.ts` (`Gate 3: Functional equivalence between HTTP and Telegram`)
- **Procedura**:
  1. Creazione di una pratica via REST HTTP (`POST /practices`) con payload JSON.
  2. Creazione di una pratica via comando Telegram deterministico (`crea pratica <nome>`) elaborato tramite `executeCommand`.
  3. Verifica della perfetta parità del modello: stesso `schemaVersion`, stesso stato iniziale `CREATED`.
  4. Verifica della sincronizzazione di stato sia via endpoint HTTP `GET /practices/:id` che via comando Telegram `stato pratica <nome>`.
  5. Esecuzione dell'export sia via HTTP (`POST /practices/export`) sia via comando Telegram (`export pratiche mese`): verifica che il formato CSV e i contenuti generati siano identici.
- **Esito**: **PASSED**. Totale equivalenza funzionale cross-channel.

### Gate 4: Analisi EXPLAIN Query Plan sugli Indici Primari

- **File di Script**: `scripts/explain-queries.ts`
- **File di Test**: `tests/gate.phase2.test.ts` (`Gate 4: Verifies EXPLAIN query plans on primary indexes`)
- **Piani di Esecuzione Rilevati (PostgreSQL 17)**:
  1. **Query Tenant + Status**:
     ```sql
     EXPLAIN SELECT * FROM "practice"
     WHERE "tenant_id" = '...' AND "status" = 'CREATED'
     ORDER BY "created_at" DESC;
     ```
     _Piano_: `Index Scan using practice_tenant_id_status_idx on practice (cost=0.15..8.17 rows=1 width=104)`.
  2. **Query JSONB Payload con GIN**:
     ```sql
     EXPLAIN SELECT * FROM "practice"
     WHERE "tenant_id" = '...' AND "payload" @> '{"type": "music_practice"}';
     ```
     _Piano_: `Bitmap Heap Scan on practice` con `Bitmap Index Scan on practice_tenant_id_payload_gin_idx / practice_tenant_id_id_version_idx`.
  3. **Query Scheduler Run Idempotency Key**:
     ```sql
     EXPLAIN SELECT * FROM "scheduler_run"
     WHERE "idempotency_key" = 'tenant:task:frequency:period';
     ```
     _Piano_: `Index Scan using scheduler_run_idempotency_key_key on scheduler_run (cost=0.15..8.17 rows=1 width=172)`.
- **Esito**: **PASSED**. Nessun Sequential Scan sulle tabelle principali; indici ottimali per carichi ad alto volume.

---

## 5. Risultati della Suite di Test e Verifiche di Qualità

Tutti i controlli di qualità e test automatici del progetto risultano **al 100% conformi**:

```bash
# 1. Test Suite Completa (Vitest)
npm test
# Esito: 15 file di test passati (15/15), 49 test passati (49/49)

# 2. Verifica dei Piani EXPLAIN delle Query
npm run db:explain
# Esito: Tutti i piani di esecuzione confermano Index Scan / Bitmap Index Scan

# 3. Type Checking TypeScript
npm run typecheck
# Esito: 0 errori di tipo (tsc -p tsconfig.json --noEmit)

# 4. Linting del Codice (ESLint)
npm run lint
# Esito: 0 violazioni o warning

# 5. Formattazione del Codice (Prettier)
npm run format:check
# Esito: Tutti i file conformi allo stile Prettier

# 6. Scansione Segreti e Sicurezza
npm run secret:scan
# Esito: Nessun segreto o credenziale individuata nel repository
```

---

## 6. Struttura dei File Modificati e Creati

```
SinfonIA/
├── prisma/
│   ├── schema.prisma                                     # Schema con indici GIN, scheduler_job, scheduler_run, outbox
│   └── migrations/
│       ├── 20261026110000_phase1_identity_and_isolation/ # Migrazione tenant_id, audit_log, triggers
│       ├── 20261026120000_phase1_tenant_binding_tables/  # Tabelle di binding
│       ├── 20261026130000_phase2_canonical_practice/     # Modello canonical practice
│       ├── 20261026140000_phase2b_payload_gin_index/     # Indice GIN su payload JSONB
│       └── 20261026150000_phase2c_durable_scheduler_and_outbox/ # Scheduler e outbox tables
├── scripts/
│   ├── auth.token.ts                                     # CLI per generazione JWT con ruoli
│   ├── tenant.provision.ts                               # CLI provisioning tenant e admin
│   └── explain-queries.ts                                # Script esecuzione EXPLAIN sulle query principali
├── src/
│   ├── core/
│   │   ├── practice/
│   │   │   ├── practice.application.service.ts           # Service canonico per CRUD, export, comandi
│   │   │   ├── practice.commands.ts                      # Parser comandi deterministici Telegram/CLI
│   │   │   ├── practice.export.ts                        # Generatore export CSV con filtri temporali
│   │   │   └── practice.payload.ts                       # Tipi e validazione del payload JSONB
│   │   └── scheduler/
│   │       └── scheduler.service.ts                      # Scheduler durevole con advisory lock e idempotenza
│   ├── data/
│   │   └── repositories/
│   │       ├── practice.repository.ts                    # Repository pratiche con ricerca, filtri, paginazione
│   │       ├── scheduler.repository.ts                   # Gestione job, run e advisory lock
│   │       └── outbox.repository.ts                      # Gestione messaggi outbox transazionali
│   └── interface/
│       └── http/
│           ├── routes/
│           │   └── practice.routes.ts                    # Rotte REST /practices (create, get, list, export)
│           └── validation/
│               └── practice.validation.ts                # Schema di validazione Zod per HTTP input
├── tests/
│   ├── gate.phase2.test.ts                               # Suite Gate 2D (4 gate completi)
│   ├── practice.api.test.ts                              # Test API REST per /practices
│   ├── practice.commands.test.ts                         # Test parser comandi
│   ├── practice.service.test.ts                          # Test service canonico
│   └── scheduler.test.ts                                 # Test scheduler durevole e outbox
└── docs/
    └── FASI_1_E_2_REPORT.md                              # Questo documento di sintesi e dettaglio
```
