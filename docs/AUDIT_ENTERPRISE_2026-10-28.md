# SinfonIA — Audit Enterprise del Repository

**Data**: 28/10/2026 · **Commit analizzato**: `4f2b1f3` (branch `main`, working tree pulito)
**Perimetro**: 192 file tracciati, ~16.000 righe TypeScript (src + tests + scripts), 10 migrazioni Prisma, 5 documenti in `docs/`.
**Metodo**: lettura del codice sorgente, confronto puntuale con README e report di fase, esecuzione reale dei quality gate e della test suite su PostgreSQL 17 locale.

---

## 1. Sintesi esecutiva

SinfonIA è un **backend Node.js/TypeScript (Fastify + Prisma + PostgreSQL)** con due canali d'ingresso (REST e bot Telegram) e un layer AI che traduce linguaggio naturale in comandi strutturati sulle "pratiche". Non esiste frontend, né dashboard, né layer di automazione.

Il **nucleo transazionale (Fasi 0–2) è solido e realmente funzionante**: multi-tenancy con trigger DB, JWT HS256 verificato correttamente, RBAC, macchina a stati, audit log immutabile, API pratiche, scheduler idempotente. La qualità del codice è buona e i gate tecnici passano quasi tutti.

La **Fase 3 è invece sovradichiarata nella documentazione**. Tre punti critici:

1. **L'"OCR / Document AI" non è OCR**: il file viene decodificato come testo UTF‑8 e analizzato con regex. Foto e PDF reali (il caso d'uso dichiarato: foto di fatture da smartphone) **non producono alcuna estrazione**.
2. **L'evaluation harness con risultato "100%" è autoreferenziale**: in CI l'LLM è simulato e restituisce la risposta attesa letta dallo scenario stesso. Il 100% non misura la qualità di alcun modello.
3. **I "pilastri" 2 e 3 della roadmap (Push/Outbox dispatcher e WhatsApp) non esistono**: le etichette "Fase 3C" e "3D" sono state riassegnate a sicurezza prompt ed evaluation; il cronoprogramma non è stato aggiornato.

Sono inoltre presenti **due difetti funzionali reali** nello scheduler (advisory lock su connection pool, export limitato alle pratiche del primo admin) e una **minimizzazione PII parziale** (i nomi delle persone vengono inviati all'LLM in chiaro, contrariamente a quanto dichiarato nel documento GDPR).

**Giudizio complessivo**: base architetturale valida per un MVP/pilota controllato; **non pronta per produzione enterprise** senza gli interventi P0/P1 della sezione 6.

---

## 2. Verifiche eseguite (risultati reali)

| Controllo | Comando | Esito | Nota |
| :--- | :--- | :--- | :--- |
| Typecheck | `npm run typecheck` | ✅ 0 errori | |
| Lint | `npm run lint` | ✅ 0 errori/warning | |
| Formattazione | `npm run format:check` | ❌ **FALLISCE** | 4 file non conformi: `src/ai/evaluation/{evaluation.harness,evaluation.types,golden-set}.ts`, `scripts/run-eval.ts`. **La CI su `main` è quindi rossa** (lo step `Format check` precede i test). Il report Fase 3 dichiara "100% conforme". |
| Secret scan | `npm run secret:scan` | ✅ nessun segreto nei file tracciati | `.env` / `.env.test` locali contengono chiavi reali (OpenAI `sk-…`, token Telegram) ma sono correttamente ignorati da Git |
| Audit dipendenze prod | `npm audit --omit=dev` | ✅ 0 vulnerabilità | |
| Migrazioni | `prisma migrate deploy` | ✅ 10/10 applicate | |
| Test suite | `vitest run` (PG 17 su :5433) | ✅ **20 file, 100/100 test** | 10 file usano il DB reale; i test AI/OCR/security usano mock o stub |
| Build | `npm run build` | ✅ | `dist/` contiene cartelle orfane di build precedenti (`domain/`, `modules/`): la build non pulisce l'output |
| AI eval (CI) | `npm run ai:eval` | ✅ 19/19 "PASSED" | **Non significativo**: LLM simulato (vedi §4.3) |
| AI eval reale | `npm run ai:eval:nightly` | ⏭️ non eseguito | Richiede chiamate a pagamento a OpenAI; nessun job nightly configurato in CI |

---

## 3. Matrice dello stato delle funzionalità

Legenda: 🟢 **Funzionante** (implementato, cablato e testato) · 🟡 **Parziale** (esiste ma con limiti sostanziali o difetti) · 🔵 **Pianificato** (solo in roadmap) · 🔴 **Bloccato/Difettoso** (presente ma non affidabile) · ⚫ **Assente** (dichiarato o atteso, nessuna traccia)

### 3.1 Piattaforma e sicurezza (Fasi 0–1)

| Funzionalità | Stato | Evidenza |
| :--- | :---: | :--- |
| Multi-tenancy con `tenant_id` su tutte le entità + indici compositi | 🟢 | `prisma/schema.prisma` |
| Trigger PostgreSQL di coerenza user/tenant su `practice` e `audit_log` | 🟢 | migrazione `phase1_identity_and_isolation`, test `data.test.ts` |
| Row-Level Security PostgreSQL | ⚫ | Nessuna `ENABLE ROW LEVEL SECURITY`: l'isolamento è applicativo + trigger |
| JWT HS256 (firma, `alg` vincolato, `timingSafeEqual`, `iss`/`aud`/`exp`) | 🟢 | `src/interface/http/auth/token.ts`, `auth.test.ts` |
| RBAC `ADMIN`/`OPERATOR`/`MEMBER` sulle rotte | 🟢 | `guards.ts`, `auth.types.ts` |
| Emissione token per utenti finali (login, refresh, revoca) | ⚫ | Solo CLI `npm run auth:token`; nessun identity provider né endpoint di login |
| Provisioning tenant + invito + admin | 🟢 | `scripts/tenant.provision.ts` |
| Audit log append-only (immutabile) | 🟢 | migrazione `audit_log_immutable`, scritto su create/transition/delete |
| Logging Pino con redaction | 🟢 | `src/shared/logger.ts` (ma molti `console.log` diagnostici in `index.ts` e `runtime.dbWatcher.ts`, es. `// TEMP DIAGNOSTIC`) |
| Health `/healthz` e readiness `/readyz` reali | 🟢 | `server.ts`, `system.test.ts` |
| Runtime self-healing (DB watcher, circuit open, recovery) | 🟢 | `src/runtime/*` |
| Rate limiting, CORS, security headers | ⚫ | Commento in `server.ts`: *"Future-ready: auth middleware, rate limiting (structure only)"* |
| CI GitHub Actions (secret scan, migrate, typecheck, lint, format, test, build, audit) | 🟡 | Pipeline completa ma **attualmente rossa** per il format check |
| Process lock su file PID | 🟡 | `.runtime/dev.pid` nella cwd: nato per il dev; in produzione impedisce due istanze nella stessa directory e termina con exit code 0 (silenzioso) |

### 3.2 Dominio pratiche e canali (Fase 2)

| Funzionalità | Stato | Evidenza |
| :--- | :---: | :--- |
| Modello canonico `Practice` + payload JSONB versionato | 🟢 | `practice.payload.ts`, migrazione `phase2_canonical_practice` |
| Macchina a stati `CREATED→VALIDATED/SUBMITTED→COMPLETED/FAILED` | 🟢 | `state-machine.ts`, `workflow-state.test.ts` |
| Lock ottimistico (`version`) | 🟢 | `practice.repository.ts`, `concurrency.errors.ts` |
| Indice GIN su payload | 🟢 | migrazione `phase2b`, gate EXPLAIN |
| `POST/GET /practices`, `GET /practices/:id`, transition, export CSV | 🟢 | `practice.routes.ts`, `practice.api.test.ts` |
| Cancellazione pratica | 🟡 | Solo via comando chat (`DELETE_PRACTICE`), nessuna rotta REST |
| Export CSV | 🟡 | Carica **tutte** le pratiche del tenant in memoria e filtra in JS; esporta solo nome e data |
| Bot Telegram: binding con codice invito, comandi deterministici, ruolo da DB | 🟢 | `telegram.bot.ts`, `telegram.client.test.ts`, gate parità HTTP/Telegram |
| Memoria conversazionale Telegram | 🟡 | `Map` in-process (`telegram.memory.ts`): persa al riavvio, non condivisa tra repliche |
| Scheduler durevole con idempotency key + tabella `scheduler_run` | 🟢 | `scheduler.service.ts`, gate 1 |
| Mutua esclusione multi-worker via advisory lock | 🔴 | **Difetto**: lock *session-level* acquisito/rilasciato via Prisma su connection pool → acquisizione e rilascio possono avvenire su connessioni diverse (vedi §5.1) |
| Export programmato tenant-wide | 🔴 | **Difetto**: lo scheduler passa `userId: adminUser.id` → esporta solo le pratiche create dal primo admin (vedi §5.2) |
| Scheduler cablato in runtime | 🟡 | Avviato dentro il DB watcher (`setInterval` 10s); accoppiamento improprio health-check/job |
| Tabella `outbox_message` (scrittura) | 🟢 | Lo scheduler scrive `PRACTICE_EXPORT_GENERATED` |
| **Outbox dispatcher** (consegna, retry, dead-letter) | ⚫ | `getPendingMessages`/`markProcessed` esistono ma **nessuno li invoca**: i messaggi restano `PENDING` per sempre |

### 3.3 Layer AI (Fase 3)

| Funzionalità | Stato | Evidenza |
| :--- | :---: | :--- |
| Interprete LLM OpenAI (`json_object`, timeout, usage token) | 🟢 | `openai.provider.ts` — testato solo con stub; nessun test automatico contro il modello reale |
| Modalità LLM disabilitata → HTTP 503 + fallback deterministico | 🟢 | `ai.routes.ts`, `ai.phase3a.test.ts`, gate 3D-1 |
| Schema output versionato (`schemaVersion: 1`) + validazione Zod | 🟢 | `interpreter.types.ts` (il report cita un inesistente `command.schema.ts`) |
| Riparazione JSON + retry con feedback | 🟢 | `json-repair.ts`, `interpreter.service.ts`, `ai.step3b.test.ts` |
| Soglia di confidenza e flusso `clarification_required` | 🟢 | `decision.engine.ts` |
| Context retrieval con ricerca keyword | 🟡 | Funziona, ma `listPractices` carica tutte le righe e poi taglia (`slice`) in memoria |
| `AITracer` + `GET /ai/traces` | 🟡 | Buffer in memoria (perso al riavvio, per processo). Il report dichiara filtri `outcome`/`from`/`to`/`limit`: **non implementati** (limite fisso 50) |
| Delimitazione `<user_input>` + escaping | 🟢 | `prompt-guard.ts`, usato in `interpreter.prompt.ts` |
| PromptGuard anti-injection | 🟡 | Funziona sui pattern noti, ma è una blacklist di 10 regex principalmente in inglese: facilmente aggirabile (parafrasi, italiano, encoding). "0% bypass" vale solo sui 4 casi del golden set |
| Minimizzazione PII (CF, IBAN, carte, email, telefono) | 🟡 | `pii-minimizer.ts` funziona su questi pattern; **i nomi delle persone e i nomi pratica nel contesto vengono inviati all'LLM in chiaro** (`interpreter.prompt.ts` riga ~92) |
| Upload allegati `POST/GET /practices/:id/attachments` | 🟡 | Solo base64 JSON (il report dichiara multipart: non esiste). Nessuna whitelist MIME né limite esplicito (vale il default Fastify 1 MB ≈ 750 KB di file) |
| Storage allegati isolato per tenant | 🟡 | Solo filesystem locale `.runtime/storage`; S3/MinIO dichiarato ma assente. Controllo path traversal con `startsWith` senza separatore |
| Ricezione foto/documenti su Telegram | 🟡 | Scarica il file e lo associa all'**ultima pratica in memoria** o alla prima della lista: rischio di allegare al fascicolo sbagliato senza conferma |
| **OCR / Document AI** | 🔴 | **Non è OCR**: `extractRawText` fa `Buffer.toString('utf-8')` e regex. Funziona solo se il "documento" è già testo. Immagini JPEG e PDF → documento generico senza dati. Nessun motore OCR, nessuna chiamata a modelli vision |
| Evaluation harness + golden set (19 scenari) | 🔴 | Infrastruttura presente, ma in CI l'LLM è **simulato a partire dalla risposta attesa** (`simulateLlmResponse(scenario)`): il 100% è tautologico. Token e costi sono stime fisse |

### 3.4 Roadmap (Fasi 3 "pilastri", 4, 5)

| Funzionalità | Stato | Nota |
| :--- | :---: | :--- |
| Scadenzario compliance (`compliance_deadline`, job `CHECK_COMPLIANCE_DEADLINES`) | 🔵 | Nessun modello, job o test (`tests/compliance.scheduler.test.ts` non esiste) |
| Notifiche push proattive | 🔵 | Dipende dall'outbox dispatcher assente |
| Canale WhatsApp Business (webhook Meta, `whatsapp_identity`) | 🔵 | Nessun file in `src/interface/whatsapp/` |
| Connettore Odoo multi-company | 🔵 | `src/automation/index.ts` è un placeholder vuoto (`export {}`) |
| Connettori PA (INPS/ex-ENPALS, SIAE, SDI) | 🔵 | Nessuna traccia |
| OpenTelemetry / Prometheus | 🔵 | Nessuna dipendenza né instrumentazione |
| Dashboard web per funzionari di rete | 🔵 | Nessun frontend nel repository |
| Rollout pilota | 🔵 | — |

---

## 4. Discrepanze tra documentazione e codice

| # | Documento | Affermazione | Realtà |
| :- | :--- | :--- | :--- |
| 4.1 | `CRONOPROGRAMMA_EVOLUTIVO.md` vs commit | 3C = Push/Outbox, 3D = WhatsApp | I commit `315b8de`/`3a75a9a` usano 3C = prompt security, 3D = evaluation. Le funzionalità di roadmap 3C/3D **non sono state realizzate** ma la numerazione suggerisce il contrario; la roadmap indica ancora "3A in corso" |
| 4.2 | `FASE_3_REPORT.md` | Motore OCR in `document.ocr.engine.ts`, schema in `command.schema.ts` | File inesistenti; reali: `document-ocr.service.ts`, `interpreter.types.ts` |
| 4.3 | `FASE_3_REPORT.md` | "Success Rate 100%, 0% bypass" | Misurato con LLM simulato che restituisce l'output atteso |
| 4.4 | `FASE_3_REPORT.md` | Upload "multipart o base64", OCR "sincrona/asincrona" | Solo base64, solo sincrono |
| 4.5 | `FASE_3_REPORT.md` | `/ai/traces` filtrabile per outcome, intervallo, limit | Nessun filtro, limite fisso |
| 4.6 | `FASE_3_REPORT.md` | Prettier "100% conforme" | 4 file non conformi, CI rossa |
| 4.7 | `DATA_RESIDENCY_AND_GDPR.md` | "Il provider esterno riceve solo token pseudonimizzati" | Nomi di persone e nomi pratiche inviati in chiaro |
| 4.8 | `DATA_RESIDENCY_AND_GDPR.md` | "L'OCR multimodale elabora i dati nel perimetro"; supporto Azure OpenAI EU | Nessun OCR multimodale; esiste solo il provider OpenAI pubblico (`api.openai.com`), nessun endpoint Azure/EU configurabile |
| 4.9 | `FASI_1_E_2_REPORT.md` | FSM `CREATED→VALIDATED→IN_PROGRESS→COMPLETED/REJECTED`; claim JWT `tenant_id` | Stati reali `SUBMITTED`/`FAILED`; claim reale `tid` (il README è corretto) |
| 4.10 | `FASI_1_E_2_REPORT.md` | Gate 2: concorrenza multi-worker sicura al 100% | Il test usa `Promise.all` su due client: non copre il caso di rilascio del lock su connessione diversa (§5.1) |
| 4.11 | `README.md` | "Senza queste variabili viene usato l'interprete deterministico locale (stub)" | Senza LLM, `/ai/execute` risponde 503 salvo i 3 comandi deterministici; lo stub esiste solo nei test |

---

## 5. Difetti tecnici rilevanti

### 5.1 Advisory lock session-level su connection pool — **Alta**
`src/data/repositories/scheduler.repository.ts:22-69`: `pg_try_advisory_lock` e `pg_advisory_unlock` sono eseguiti con due `$queryRawUnsafe` indipendenti sul pool Prisma. Un lock di sessione appartiene alla connessione che lo ha acquisito: se l'unlock esce su un'altra connessione restituisce `false` e il lock **resta trattenuto** finché quella connessione vive, bloccando le esecuzioni successive di quel task/tenant (anche nello stesso worker). Correzione: `pg_try_advisory_xact_lock` dentro una `$transaction` interattiva, oppure una connessione dedicata.

### 5.2 Export schedulato limitato alle pratiche del primo admin — **Alta**
`src/core/scheduler/scheduler.service.ts`: `exportPractices({ userId: adminUser.id, … })` → `listPractices` filtra per `userId`. L'export periodico del tenant omette tutte le pratiche create da operatori e membri. Correzione: omettere `userId` per l'export di tenant.

### 5.3 Outbox senza consumer — **Alta (funzionale)**
Gli export generati non vengono mai consegnati. Il "pattern outbox" è solo metà implementato.

### 5.4 OCR fittizio — **Alta (di prodotto)**
Vedi §3.3. Il caso d'uso principale del "Pilastro 1" non è soddisfatto.

### 5.5 Allegati Telegram associati per euristica — **Media**
Il file viene legato all'ultima pratica in memoria o alla prima in lista, senza conferma dell'utente.

### 5.6 Query non paginate — **Media (scalabilità)**
`listPractices`, export e context retrieval caricano l'intero set di pratiche del tenant/utente.

### 5.7 Hardening HTTP mancante — **Media**
Nessun rate limiting (rilevante per `/ai/execute`, che genera costi LLM), nessun limite/whitelist MIME sugli allegati, nessun header di sicurezza.

### 5.8 Igiene del runtime — **Bassa**
`console.log` di bootstrap e diagnostica nel codice di produzione (`BOOTSTEP n`, "PHASE 5 TEST GUIDE", `TEMP DIAGNOSTIC`), process lock su file PID, `dist/` non ripulita, `ENABLE_LLM=true` in `.env.test` con chiave reale (gli harness `ai:test*` chiamano OpenAI usando quella chiave).

---

## 6. Raccomandazioni prioritarie

> **Aggiornamento 28/10/2026**: i quattro interventi P0 sono stati eseguiti (format, advisory lock di transazione, export tenant-wide, allineamento di README e documenti). I test di regressione aggiunti in `tests/scheduler.test.ts` falliscono sul codice precedente e passano con la correzione; suite completa 102/102.

| Priorità | Intervento | Effort indicativo |
| :--- | :--- | :--- |
| **P0** | Eseguire `npm run format` sui 4 file e riportare la CI al verde | minuti |
| **P0** | Correggere advisory lock (§5.1) con xact-lock in transazione + test di regressione su lock non rilasciato | 0,5 g |
| **P0** | Correggere export schedulato tenant-wide (§5.2) | ore |
| **P0** | Allineare `FASE_3_REPORT.md`, `DATA_RESIDENCY_AND_GDPR.md` e cronoprogramma allo stato reale (OCR, eval, PII nomi, numerazione fasi) prima di condividerli con clienti o enti | 0,5 g |
| **P1** | Implementare un vero OCR (es. modello vision o servizio Document AI EU) dietro l'interfaccia `DocumentOcrService` esistente; whitelist MIME e limiti di dimensione | 3–5 g |
| **P1** | Outbox dispatcher con retry esponenziale e dead-letter | 2–3 g |
| **P1** | Eval reale: job nightly in CI con modello vero e golden set ampliato (parafrasi, italiano, injection non banali) | 2 g |
| **P1** | Pseudonimizzazione dei nomi nel contesto LLM o base giuridica/DPA esplicita; provider EU configurabile (Azure OpenAI) | 2–3 g |
| **P1** | Rate limiting e security headers (`@fastify/rate-limit`, `@fastify/helmet`) | 0,5 g |
| **P2** | Paginazione/streaming per export e context; tracer persistente; memoria Telegram su DB/Redis; separare scheduler dal DB watcher; pulizia log di bootstrap | 3–4 g |
| **P2** | Flusso di autenticazione per utenti finali (oggi solo token da CLI) | da definire |

---

## 7. Conclusione

| Area | Maturità |
| :--- | :--- |
| Fondamenta (tenant, auth, RBAC, audit, workflow, API pratiche) | **Buona — utilizzabile** |
| Scheduler e outbox | **Parziale — difetti da correggere prima di repliche multiple** |
| AI interprete e guardrail | **Funzionante ma validato solo su stub** |
| Document AI / OCR | **Non funzionante sul caso d'uso reale** |
| Pilastri Push e WhatsApp, Odoo, PA, telemetria, dashboard | **Non iniziati** |

Lo stato reale corrisponde alla **Fase 2 completata e Fase 3 parzialmente completata** (3A e 3B-interprete solidi; 3B-OCR, sicurezza e valutazione da consolidare), non alla "Fase 3 completata al 100%" dichiarata nei report.
