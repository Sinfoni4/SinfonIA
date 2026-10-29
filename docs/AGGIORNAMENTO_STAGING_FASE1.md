# Aggiornamento dello staging alla Fase 1 (MF1, MF3, MF4, MF5, MF2b)

**Data**: 29/10/2026 · **Stato**: procedura pronta, **non eseguita** · Riferimenti: `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` §9, `docs/BACKUP_RIPRISTINO_E_RUOLI.md` (in MF1)

Lo staging gira sul PC: database `sinfonia_staging` nel cluster PostgreSQL sulla porta 5433, applicazione avviata dalla cartella del repository sulla porta 3110, allegati in `.runtime/storage`. Ogni passo indica chi lo esegue.

## 0. Prerequisiti

|  #  | Passo                                                                                                                                                                                                                                                                                          | Chi          |
| :-: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| 0.1 | Unione in `main`, in quest'ordine: #13 (MF1), #14 (MF3), #15 (MF4), #16 (MF5), #17 (MF2b), #19 (Mistral), #18 (documenti), più la PR di questi script. #15–#17 vanno prima ribasate su `main` («Edit» → base `main`). L'unione di tutti i rami è già stata provata in locale: 425 test passati | proprietario |
| 0.2 | Chiave del backup: 32 byte casuali, conservati **fuori dal repository** (es. gestore di password). Senza la chiave il backup non si ripristina. Comando per crearla: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                                             | proprietario |
| 0.3 | Cartella dei backup fuori dal repository, possibilmente su un altro disco                                                                                                                                                                                                                      | proprietario |
| 0.4 | Password nuove per i ruoli `sinfonia_owner`, `sinfonia_app`, `sinfonia_backup`, conservate fuori dal repository                                                                                                                                                                                | proprietario |

## 1. Backup cifrato e prova di ripristino

```bash
BACKUP_SOURCE_URL=<url di sinfonia_staging> BACKUP_KEY=<chiave> BACKUP_DIR=<cartella> \
BACKUP_STORAGE_DIR=.runtime/storage BACKUP_GLOBALS=yes npm run db:backup
```

Lo script:

- crea il dump e lo cifra mentre lo scrive, senza testo in chiaro su disco;
- lo rilegge per intero attraverso la decifratura, verificando il sigillo della cifratura e che ogni tabella sia presente;
- cifra gli allegati file per file;
- scrive `manifest.json`, con conteggi, impronte e migrazioni e senza dati.

Prova di ripristino su un database **vuoto** creato per l'occasione:

```bash
RESTORE_FROM=<cartella del backup> BACKUP_KEY=<chiave> RESTORE_TARGET_URL=<url di un database vuoto> \
npm run db:restore
```

Lo script verifica il file con il manifest e rifiuta un database non vuoto, una chiave errata o un file alterato. Dopo la prova il database temporaneo va cancellato.
Nota: i dati sono già sul PC nello staging; la copia temporanea non aggiunge esposizione diversa, ma va eliminata subito.

## 2. Migrazioni

1. Arresto dell'applicazione di staging (processo sulla porta 3110).
2. `git checkout main && git pull`, poi `npm ci` e `npx prisma generate`.
3. `npx prisma migrate deploy` sul database di staging: applica MF3, cioè le tabelle nuove con riempimento dai dati attuali, e MF4, cioè i controlli sulle appartenenze.
4. `npx tsx scripts/db/mf3-verify.ts` sullo staging: tutte le verifiche devono risultare `OK`.

**Rollback**: script in `prisma/rollback/` in ordine inverso (MF4, poi MF3), oppure ripristino del backup del passo 1 in un database vuoto.

## 3. Ruoli PostgreSQL (MF1)

```bash
DB_ADMIN_URL=<url di sinfonia_staging con il superutente> DB_OWNER_PASSWORD=… DB_APP_PASSWORD=… \
DB_BACKUP_PASSWORD=… DB_ROLES_STAGING_APPROVED=yes npm run db:roles
```

Configurazione dell'applicazione di staging:

- `DATABASE_URL` con `sinfonia_app`;
- `MIGRATION_DATABASE_URL` con `sinfonia_owner`.

**Rollback**: `DATABASE_URL` di nuovo con le credenziali precedenti e riavvio. I ruoli restano ma non sono usati.

## 4. Riavvio e verifiche

1. Avvio sulla porta 3110.
2. `GET /readyz` → 200.
3. Bot Telegram: «lista pratiche», poi «pratiche azienda» con un ADMIN.
4. Un'operazione di scrittura: crea pratica o nuova scadenza.
5. Revoca: con un token di prova, `POST /members/:id/revoke` e verifica del 401 alla richiesta successiva della persona revocata. Poi riattivazione.

## 5. Cosa può fare Claude e cosa resta al proprietario

| Attività                                           | Chi                                                                                     |
| :------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| Unione delle PR                                    | proprietario: l'unione da parte di Claude è bloccata dalle regole di permesso           |
| Creazione e custodia di chiave e password          | proprietario: Claude non inserisce credenziali                                          |
| Arresto e riavvio del processo di staging          | Claude, solo con permesso esplicito ogni volta                                          |
| Backup, prova di ripristino, migrazioni, verifiche | Claude, con le variabili fornite dal proprietario nell'ambiente, oppure il proprietario |
