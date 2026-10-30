# SinfonIA — Ruoli del database, backup e ripristino

Procedura operativa per MF0 (backup e prova di ripristino) e MF1 (ruoli separati). Progetto e motivazioni: [PROGETTO_FASE1_IDENTITA_SICUREZZA.md](PROGETTO_FASE1_IDENTITA_SICUREZZA.md) §6, §9, §10.

## 1. Ruoli

| Ruolo | Uso | Privilegi |
| :--- | :--- | :--- |
| `sinfonia_owner` | solo migrazioni | proprietario di database, schema `public` e di tutti gli oggetti (tabelle, tipi, funzioni) |
| `sinfonia_app` | applicazione | `SELECT/INSERT/UPDATE/DELETE` sui dati; su `audit_log` solo `INSERT` e `SELECT`; nessun accesso a `_prisma_migrations`; nessun DDL, `TRUNCATE`, superuser, `BYPASSRLS`; non può disattivare i trigger |
| `sinfonia_backup` | backup | lettura di tutto (`pg_read_all_data`), nessuna scrittura |

Le tabelle create in futuro dal proprietario sono automaticamente disponibili all'applicazione (privilegi predefiniti). Le eccezioni per tabelle nuove e sensibili, come `audit_log`, vanno aggiunte a `scripts/db/roles.ts`.

### 1.1 Applicazione (idempotente)

```bash
npm run db:roles
```

Variabili: `DB_ADMIN_URL` (superutente, sul database da configurare), `DB_ROLE_PREFIX` (predefinito `sinfonia`), `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD`. Lo script:

- rifiuta i database con «staging» nel nome senza `DB_ROLES_STAGING_APPROVED=yes`;
- esegue tutto in una transazione;
- non stampa le password.

### 1.2 Configurazione dell'applicazione

| Variabile | Valore | Usata da |
| :--- | :--- | :--- |
| `DATABASE_URL` | connessione come `sinfonia_app` | applicazione |
| `MIGRATION_DATABASE_URL` | connessione come `sinfonia_owner` | `prisma migrate deploy` (letta da `prisma.config.ts`) |

Senza `MIGRATION_DATABASE_URL` le migrazioni usano `DATABASE_URL`, come prima di MF1.

### 1.3 Passaggio di un ambiente esistente (es. staging) — richiede approvazione separata

1. Backup verificato (§2) e prova di ripristino (§3).
2. `npm run db:roles` con `DB_ADMIN_URL` sul database dell'ambiente e password nuove, conservate fuori dal repository.
3. Configurazione dell'ambiente: `DATABASE_URL` → `sinfonia_app`, `MIGRATION_DATABASE_URL` → `sinfonia_owner`.
4. Riavvio dell'app; verifica di `/readyz`, del bot e di un'operazione di scrittura.

**Rollback**: si ripristina `DATABASE_URL` con le credenziali precedenti e si riavvia. I ruoli restano ma non sono usati. Se serve, si riporta la proprietà degli oggetti al vecchio proprietario con `REASSIGN OWNED BY sinfonia_owner TO <ruolo precedente>`.

## 2. Backup

Eseguito con `sinfonia_backup`, oppure con un superutente:

```bash
pg_dump --format=custom --file=sinfonia_<data>.dump <database>
pg_dumpall --globals-only --no-role-passwords > ruoli_<data>.sql
```

- `pg_dump` salva dati, schema, proprietari e privilegi degli oggetti.
- `pg_dumpall --globals-only` salva i ruoli e i loro attributi, senza password: dopo un ripristino su un nuovo server le password vanno reimpostate.
- **Non salvati da `pg_dump`**: proprietario del database e permessi di connessione. Vengono rimessi da `npm run db:roles` dopo il ripristino.
- Allegati: copia della cartella dello storage, oppure del bucket S3.
- I file di backup contengono dati personali: vanno cifrati e conservati fuori dal server del database. La politica di conservazione è in §8 del piano.

## 3. Ripristino

1. Ruoli: `psql -f ruoli_<data>.sql` sul nuovo server, poi password con `npm run db:roles`.
2. Database vuoto, poi `pg_restore --dbname=<database> --exit-on-error sinfonia_<data>.dump`.
3. `npm run db:roles` (proprietario del database, permessi di connessione, privilegi).
4. Ripristino degli allegati.
5. Verifiche: `npx prisma migrate status` (con `MIGRATION_DATABASE_URL`), `/readyz`, una lettura e una scrittura di prova.

## 4. Prova di ripristino senza dati in chiaro (MF0)

`scripts/backup/mf0-restore-test.ts` esegue il backup cifrato a flusso e il ripristino con sostituzione dei valori personali in un cluster isolato. Verifica righe, schema, vincoli, trigger, lettura applicativa e assenza di file temporanei. Uso, protezioni e approvazioni: §10 del piano.

```bash
MF0_SOURCE_URL=... MF0_TARGET_URL=... MF0_WORK_DIR=... npx tsx scripts/backup/mf0-restore-test.ts
```

Lo staging come sorgente richiede `MF0_PHASE=2` e `MF0_STAGING_APPROVED=yes`, cioè l'approvazione prevista dal piano.

## 5. Verifiche eseguite (29/10/2026)

| Verifica | Dove | Esito |
| :--- | :--- | :--- |
| Privilegi effettivi dei tre ruoli (`tests/db.roles.test.ts`) | database temporaneo, creato e rimosso dal test | superata; si esegue anche in CI |
| Intera suite di test come `sinfonia_app` | cluster isolato sintetico (porta 5434) | 393 test superati: l'app non usa privilegi oltre ai dati |
| Ripristino completo con proprietari e privilegi | stesso cluster, nuovo database | proprietari, privilegi sulle tabelle e privilegi predefiniti identici |
| `pg_dumpall --globals-only --no-role-passwords` | stesso cluster | ruoli e attributi salvati, password escluse |
| Backup e ripristino dello staging con sostituzione dei valori (MF0 fase 2) | staging in sola lettura, cluster isolato | superata (§10.13 del piano) |

Non ancora verificato: ripristino su un **server diverso**, con ricreazione dei ruoli dal file dei globali (da fare in MF11, sull'ambiente cifrato del pilota).
