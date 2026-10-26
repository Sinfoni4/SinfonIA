# SinfonIA

Enterprise middleware mission-critical tra utenti, cooperative e sistemi pubblici.

## Architettura (layered)

Struttura logica a livelli (monorepo modulare, non microservizi distribuiti):

- `src/interface`: input/output (REST, placeholder chatbot)
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
npm run db:migrate
# opzionale: bootstrap PostgreSQL locale in sviluppo
npm run db:setup
```

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

I test Vitest caricano `.env.test` in modo deterministico. In CI il database è
fornito dal servizio PostgreSQL e `DATABASE_URL` ha precedenza sul file locale.

## Segreti

`.env` e `.env.*` sono ignorati da Git; solo `.env.example` è versionato con
placeholder. Non inserire token o chiavi nel codice. Se un token è stato
esposto, revocalo e generane uno nuovo prima di riavviare il bot.
