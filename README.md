# SinfonIA

Enterprise middleware mission-critical tra utenti, cooperative e sistemi pubblici.

## Architettura (layered)

Struttura logica a livelli (monorepo modulare, non microservizi distribuiti):

- `src/interface`: input/output (REST, Telegram)
- `src/ai`: orchestrazione AI (parsing NL → intent strutturato) **senza logica di business**
- `src/core`: logica deterministica (workflow, validazioni, regole)
- `src/automation`: esecuzione task esterni (RPA/integration runner)
- `src/data`: persistenza, tenant isolation, audit log
- `src/shared`: cross-cutting (logger, config, types condivisi)

Regola di dipendenze (semplificata):

- Interface → Core → Data
- AI è parallelo al Core (produce intent strutturati, non decide)
- Il wiring tra layer avviene nel composition root `src/index.ts`

## Setup locale

Requisiti: Node.js 22 (vedi `.nvmrc`) e PostgreSQL.

1. Copia il template e inserisci i valori locali. Il file `.env` non viene creato
   automaticamente e non deve mai essere committato.

```bash
cp .env.example .env
```

2. Installa le dipendenze:

```bash
npm ci
```

3. Prepara il database (operazione manuale, mai eseguita all'avvio):

```bash
npm run db:generate
npm run db:migrate:deploy
# opzionale: bootstrap PostgreSQL locale in sviluppo
npm run db:setup
```

## Autenticazione e tenant isolation

Tutte le rotte applicative richiedono un bearer token HS256 firmato con
`AUTH_SECRET` (minimo 32 caratteri; puoi generarlo con
`openssl rand -base64 32`). I claim obbligatori sono `sub` (userId),
`tid` (tenantId), `role` (`ADMIN|OPERATOR|MEMBER`), `iat`, `exp`, `iss`, `aud`.
Il tenant nel token è autoritativo: gli header `x-tenant-id` e `x-user-id` non
sono più letti né considerati.

Genera un token locale per un utente già presente nel database:

```bash
npm run auth:token -- --tenant <tenant-uuid> --user <user-uuid> --role ADMIN
```

Esempio di chiamata:

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/auth/whoami
```

- `GET /healthz` e `GET /readyz` sono pubblici.
- `GET /auth/whoami` restituisce subject, tenant e ruolo del token.
- `POST /practices` crea una nuova pratica per l'utente autenticato (`ADMIN|OPERATOR|MEMBER`).
- `GET /practices` restituisce la lista paginata con ricerca (`search`), filtri per stato e ordinamento.
- `GET /practices/:id` restituisce il dettaglio di una singola pratica.
- `POST /practices/export` esporta le pratiche in formato CSV con filtri temporali.
- `POST /practices/:id/transition` richiede `ADMIN` o `OPERATOR`.
- `POST /ai/execute` richiede un qualsiasi ruolo autenticato.

## Provisioning di un tenant

Il provisioning crea tenant, codice invito e utente amministratore in una sola
operazione. Non vengono creati tenant demo o fallback impliciti.

```bash
npm run tenant:provision -- --name "Cooperativa Demo" --admin-email admin@example.com --admin-telegram-id 123456789
```

Il bot Telegram collega un account con `/start <codice-invito>`. Il ruolo
Telegram viene letto dal database: non esiste più un comando `/role` per
auto-assegnarsi i permessi. Per abilitare subito un amministratore su Telegram,
passa il suo id numerico con `--admin-telegram-id` durante il provisioning.

La configurazione del tenant (modulo, integrazione, scheduler) è persistita in
`tenant`; lo scheduler usa solo tenant reali e richiede un utente `ADMIN` per
l'esecuzione. I trigger PostgreSQL verificano che `practice.user_id` e
`audit_log.user_id` appartengano allo stesso tenant.

## Scheduler durevole e Outbox

Lo scheduler (`src/core/scheduler/scheduler.service.ts`) è completamente durevole, idempotente e sicuro contro corse critiche:

- **Task registrati**: ogni tipo di task è un handler (`src/core/scheduler/scheduler.tasks.ts`). I task configurati nel tenant (oggi `EXPORT_PRACTICES`) girano se `scheduler_enabled`; i task di sistema (`CHECK_COMPLIANCE_DEADLINES`, giornaliero) girano per ogni tenant.

- **Persistenza & Idempotenza**: i job sono persistiti in `scheduler_job` e ogni esecuzione è tracciata in `scheduler_run` con vincolo UNIQUE su `idempotency_key` (`<tenantId>:<taskType>:<frequency>:<period>`).
- **Nessun burst all'avvio**: lo stato non è più volatile in-memory; al riavvio del processo lo scheduler verifica nel DB le esecuzioni già completate per il periodo corrente evitando riesecuzioni immediate.
- **PostgreSQL Advisory Lock**: esecuzione protetta da un advisory lock di transazione (`pg_try_advisory_xact_lock`), rilasciato automaticamente al commit o rollback, garantendo che in presenza di repliche multiple solo un worker alla volta esegua il task per un tenant.
- **Export tenant-wide**: l'export schedulato include le pratiche di tutti gli utenti del tenant.
- **Outbox e consegna**: gli export generati dai job vengono scritti in `outbox_message` e consegnati dal dispatcher (`src/core/outbox/outbox.dispatcher.ts`):
  - **Telegram**: file CSV a ogni utente `ADMIN` del tenant collegato a Telegram.
  - **Webhook**: `POST` JSON all'URL del tenant (`tenant.webhook_url`), solo HTTPS in produzione. Header `x-sinfonia-event`, `x-sinfonia-delivery` (id stabile tra i tentativi, per deduplicare), `x-sinfonia-timestamp` e `x-sinfonia-signature: sha256=<HMAC-SHA256 di "<timestamp>.<corpo>" con OUTBOX_WEBHOOK_SECRET>`. Senza segreto i webhook non partono e il messaggio va in dead letter. In produzione sono rifiutati gli indirizzi di rete interna e i reindirizzamenti non vengono seguiti.
  - **Affidabilità**: più processi possono consegnare in parallelo senza doppioni (`FOR UPDATE SKIP LOCKED` e lease di 5 minuti); ogni destinatario consegnato viene registrato e non riceve di nuovo il messaggio. Errori temporanei: nuovo tentativo con backoff esponenziale (30 s → 1 h). Errori permanenti o tentativi esauriti (`OUTBOX_MAX_ATTEMPTS`, default 8): stato `DEAD_LETTER` con il motivo in `error`.
  - **Worker**: scheduler e dispatcher girano su intervalli propri (`SCHEDULER_INTERVAL_MS`, `OUTBOX_DISPATCH_INTERVAL_MS`), separati dal controllo di salute del database.

## Scadenzario adempimenti

Le scadenze della cooperativa e dei soci (DURC, formazione sicurezza, certificazione biologica, visite mediche, patentini) sono in `compliance_deadline` e gestite da `src/core/compliance/`.

- **API**: `POST /compliance/deadlines` (`category`, `title`, `dueDate` `AAAA-MM-GG`, `userId` facoltativo del socio interessato, `notes`), `GET /compliance/deadlines` (`status`, `category`, `userId`, `withinDays`, `limit`), `POST /compliance/deadlines/:id/close`. Creazione e chiusura: `ADMIN` e `OPERATOR`; i `MEMBER` vedono solo le scadenze che li riguardano.
- **Telegram**: `scadenze`, `nuova scadenza <tipo> <gg/mm/aaaa> <descrizione>` (tipi: durc, sicurezza, bio, visita, patentino, altro), `chiudi scadenza <codice>`.
- **Promemoria**: a 30, 15, 7 e 1 giorno e il giorno della scadenza, su Telegram agli amministratori e al socio interessato e sul webhook del tenant (tramite l'outbox). Il job `CHECK_COMPLIANCE_DEADLINES` gira ogni giorno per ogni tenant; ogni promemoria parte una sola volta (vincolo unico su scadenza e soglia) e si invia solo la soglia più vicina già raggiunta. Le date seguono il calendario italiano.

## Canale WhatsApp

Il canale WhatsApp (WhatsApp Business Cloud API di Meta) ha lo stesso comportamento del bot Telegram: la logica di conversazione è comune (`src/interface/conversation/conversation.service.ts`) e i due canali sono adattatori.

- **Attivazione**: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (tutti insieme). Nell'app Meta il webhook va puntato a `https://<host>/webhooks/whatsapp` con lo stesso verify token.
- **Sicurezza**: le richieste di Meta sono autenticate dalla firma `X-Hub-Signature-256` (HMAC-SHA256 del corpo con l'app secret); senza firma valida la richiesta è rifiutata con 401.
- **Collegamento**: il socio scrive `start <codice invito>`; il numero viene legato a un utente del tenant (`whatsapp_identity`).
- **Messaggi**: testo, foto e documenti (OCR come su Telegram); notifiche di export e scadenze tramite l'outbox.
- **Limite di Meta**: oltre 24 ore dall'ultimo messaggio dell'utente si possono inviare solo template approvati; finché non sono configurati, le notifiche in quel caso falliscono con il motivo esplicito.

## LLM (OpenAI)

Per abilitare l’interprete con un modello reale imposta in `.env`
`ENABLE_LLM=true` e `OPENAI_API_KEY=...`. Opzionale: `OPENAI_MODEL=gpt-4o-mini`.
Senza queste variabili `POST /ai/execute` accetta solo i comandi deterministici
(`crea pratica <nome>`, `stato pratica <nome>`, `export pratiche [oggi|mese|anno]`)
e risponde HTTP 503 `LLM_DISABLED` a ogni altro testo.
Test manuali con input umani: vedi [docs/MANUAL_TESTING_LLM.md](docs/MANUAL_TESTING_LLM.md).

## Workflow pratiche

La macchina a stati è definita in `src/core/workflow/state-machine.ts` ed è
condivisa da workflow, validatore e normalizzatore AI.

- `CREATED → VALIDATED | SUBMITTED`
- `VALIDATED → SUBMITTED | COMPLETED`
- `SUBMITTED → COMPLETED | FAILED`
- `FAILED` e `COMPLETED` sono terminali
- `CREATED → COMPLETED` non è consentito: una pratica deve essere validata prima
  di poter essere completata.

## Modello canonico pratica

La tabella `practice` è l’unico modello canonico. I vecchi modelli in memoria
(`ArtistPractice`) e la tabella `music_practice` sono stati rimossi; eventuali
payload legacy vengono normalizzati dalla migrazione `phase2_canonical_practice`.

`PracticeApplicationService` (`src/core/practice/`) è l’unico servizio
applicativo per create, transition, list, export e delete. HTTP, Telegram e
scheduler delegano a questo servizio e non accedono direttamente alla
persistenza delle pratiche. Ogni scrittura richiede un utente reale già
persistito e appartenente al tenant; non vengono generati UUID sintetici.

Le eventuali integrazioni con sistemi esterni restano adapter di modulo e non
possono contenere logica di dominio o scrivere direttamente su `practice`.

## Allegati e Document AI

`POST /practices/:id/attachments` accetta `multipart/form-data` (campo `file`,
campo opzionale `hint` prima del file) oppure JSON con `fileName` e
`contentBase64`. Formati ammessi, rilevati dal contenuto e non dal MIME
dichiarato: PDF, JPEG, PNG, WEBP e testo. Dimensione massima:
`ATTACHMENT_MAX_BYTES` (default 10 MB).

L'OCR gira in-process (Tesseract con modello italiano incluso nelle
dipendenze): nessun documento lascia il server. I PDF digitali vengono letti
dal livello di testo, quelli scansionati vengono rasterizzati e passati
all'OCR. Fatture, DDT, scontrini e certificati producono dati strutturati; i
campi non leggibili restano `null` e il risultato è marcato `reviewRequired`.
Le fixture di test (documenti fittizi) si rigenerano con
`npx tsx scripts/generate-ocr-fixtures.ts`.

Storage degli allegati: `STORAGE_DRIVER=local` (default, `.runtime/storage`
o `STORAGE_LOCAL_DIR`) oppure `STORAGE_DRIVER=s3` per AWS S3 o MinIO
(`S3_BUCKET`, `S3_REGION`, e per MinIO `S3_ENDPOINT` con
`S3_FORCE_PATH_STYLE=true`). Vedi `.env.example`.

Su Telegram un file viene associato direttamente solo se l'utente ha una sola
pratica aperta o se la didascalia nomina la pratica; altrimenti il bot chiede
di scegliere rispondendo con il numero.

Per misurare l'accuratezza dell'OCR su documenti reali vedi
[docs/PROTOCOLLO_PROVA_OCR.md](docs/PROTOCOLLO_PROVA_OCR.md).

## Health check

- `GET /healthz`: liveness del processo (HTTP 200 finché il processo risponde).
- `GET /readyz`: readiness reale; restituisce HTTP 503 se il database non è
  raggiungibile o il runtime è in `CIRCUIT_OPEN`.

## Comandi principali

- `npm run dev`: avvio in watch mode (`predev` valida l’ambiente senza scrivere file)
- `npm run typecheck`: typecheck (no emit)
- `npm run lint` / `npm run lint:fix`: quality gates
- `npm run format` / `npm run format:check`: Prettier
- `npm test` / `npm run test:watch`: test suite Vitest
- `npm run test:integration`: avvia il PostgreSQL di test, applica le migrazioni e lancia Vitest
- `npm run test:db:up` / `npm run test:db:down`: gestione del database di test
- `npm run test:db:reset`: ricrea da zero il database di test (distruttivo, solo test)
- `npm run test:core`, `npm run test:domain`, `npm run ai:test`: harness AI (non Vitest)
- `npm run secret:scan`: scansione di token/chiavi nei file del repository
- `npm run build` / `npm start`: build + avvio da `dist/`
- `npm run audit:prod`: audit delle dipendenze di produzione
- `npm run db:explain`: analizza con EXPLAIN i piani di esecuzione delle query principali (indici tenant, GIN payload, scheduler idempotency)
- `npm run auth:token`: genera un bearer token locale firmato
- `npm run tenant:provision`: crea tenant, invito e admin

Per il report completo e dettagliato sull'implementazione di tutte le Fasi 1 e 2 (inclusi i 4 Gate di resilienza e concorrenza), consulta [docs/FASI_1_E_2_REPORT.md](docs/FASI_1_E_2_REPORT.md).  
Per la pianificazione delle fasi successive, l'integrazione dei 3 pilastri abilitanti (Document AI/OCR, Notifiche Push e WhatsApp) e il connettore Odoo Multi-Company per reti d'imprese, consulta [docs/CRONOPROGRAMMA_EVOLUTIVO.md](docs/CRONOPROGRAMMA_EVOLUTIVO.md).

I test Vitest caricano `.env.test` in modo deterministico. In CI il database è
fornito dal servizio PostgreSQL e `DATABASE_URL` ha precedenza sul file locale.

## Logging e PII

I log applicativi non includono input utente, nomi artisti, email o token. Il
logger Pino applica redaction difensiva a header di autorizzazione, token,
chiavi, email e campi testuali sensibili. Non usare `console.log` con payload
grezzi nelle nuove integrazioni.


- Il codice di produzione scrive solo log JSON strutturati (pino, `src/shared/log.ts` o il logger iniettato); `console.*` è vietato da ESLint in `src/` tranne negli strumenti di `src/devtools/`.
- Più istanze di SinfonIA possono girare insieme (scheduler e outbox si coordinano su PostgreSQL); il polling del bot Telegram invece va attivato in una sola istanza.
## Segreti

`.env` e `.env.*` sono ignorati da Git; solo `.env.example` e
`.env.test.example` sono versionati con placeholder. Non inserire token o chiavi nel codice. Se un token è stato
esposto, revocalo e generane uno nuovo prima di riavviare il bot.
