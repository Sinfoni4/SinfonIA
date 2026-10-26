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

## LLM (OpenAI)

Per abilitare l’interprete con un modello reale imposta in `.env`
`ENABLE_LLM=true` e `OPENAI_API_KEY=...`. Opzionale: `OPENAI_MODEL=gpt-4o-mini`.
Senza queste variabili viene usato l’interprete deterministico locale (stub).
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
- `npm run auth:token`: genera un bearer token locale firmato
- `npm run tenant:provision`: crea tenant, invito e admin

I test Vitest caricano `.env.test` in modo deterministico. In CI il database è
fornito dal servizio PostgreSQL e `DATABASE_URL` ha precedenza sul file locale.

## Logging e PII

I log applicativi non includono input utente, nomi artisti, email o token. Il
logger Pino applica redaction difensiva a header di autorizzazione, token,
chiavi, email e campi testuali sensibili. Non usare `console.log` con payload
grezzi nelle nuove integrazioni.

## Segreti

`.env` e `.env.*` sono ignorati da Git; solo `.env.example` e
`.env.test.example` sono versionati con placeholder. Non inserire token o chiavi nel codice. Se un token è stato
esposto, revocalo e generane uno nuovo prima di riavviare il bot.
