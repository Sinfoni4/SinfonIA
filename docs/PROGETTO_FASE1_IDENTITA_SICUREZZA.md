# SinfonIA — Fase 1: organizzazioni, identità, autorizzazioni e sicurezza

**Stato**: direzione architetturale approvabile; MF2 e MF0 fase 1 eseguiti e in revisione (PR #9, #10) · **Data**: 29/10/2026 · **Versione**: 7
**Autorizzato finora**: preparazione documentale; MF2 su un ramo dedicato con C1 (senza C2, C3, D5b); MF0 fase 1 solo su dati sintetici. Non autorizzati: unione delle PR, MF0 fase 2 sullo staging (§10.13), migrazioni, installazioni, interventi su staging, produzione, configurazioni, dipendenze o servizi esterni.

Novità della versione 7: esecuzione di MF2 e MF0 fase 1, criterio di prestazioni assoluto con esiti (§11.5), richiesta di approvazione per MF0 fase 2 (§10.13), stato aggiornato (§16).

Novità della versione 6: percorso completo dei dati in MF0 con paging, dump, log e cartelle temporanee (§10.2–§10.4); distinzione tra pseudonimizzazione e anonimizzazione e regole di sostituzione per ogni tipo di dato (§10.5–§10.6); verifica del backup per riga e limiti dichiarati (§10.8); opzioni b e d dell'export Telegram nel dettaglio (§3.3); punti legali delle regole di cancellazione (§3.5); stato e autorizzazioni (§16).

Novità della versione 5: MF0 riprogettato senza dati personali in chiaro sul PC (BitLocker non attivo), con ripristino a flusso anonimizzato e prova di esattezza con impronte (§10); decisione aperta sull'export pianificato su Telegram (D5b, §3.3); regole di cancellazione R1–R13 (§3.5).

Novità della versione 4: protezione dei dati reali in MF0 con alternativa sintetica (§10); proposte definitive su visibilità in chat (C2, §3.4) e cancellazione (C3, §3.5); esportazioni per ruolo e canale con destinatario, dati e audit (§3.3); matrice allineata (§3.2); test in quattro stati con lacune per area (§12); approvazioni (§14) e stime (§15) aggiornate.

Convenzioni:

- **[V]** verificato nel codice, nei dati o su fonte ufficiale (con riferimento);
- **[P]** proposta progettuale, da approvare;
- **[NV]** non verificato, o da verificare con terzi (legale, privacy, fornitori).

Novità rispetto alla versione 2: decisioni confermate e aperte (§A, §B), esportazione analizzata (§3.3), beneficiari delle deleghe (§2.4), recupero degli account e collegamento atomico (§4), matrice di conservazione con verifiche legali (§8), piani esecutivi di MF0 (§10) e MF2 (§11), stato effettivo dei test (§12), email da fonti ufficiali (§13), approvazioni per attività (§14), stime con criteri di completamento (§15).

---

## A. Decisioni architetturali confermate

Confermate dal proprietario del progetto (messaggi del 29/10/2026):

1. Identità globale della persona, distinta dalle appartenenze; appartenenze multiple con ruoli diversi per organizzazione.
2. Deleghe esplicite con ambito, operazioni, durata, stato, beneficiari verificabili e revoca effettiva.
3. Nessun permesso sui dati per il solo fatto di appartenere a una rete o associazione; la gerarchia non sostituisce la verifica dei permessi.
4. Amministratore di rete distinto dall'amministratore tecnico della piattaforma; l'amministratore tecnico non ha accesso ordinario ai contenuti.
5. Accesso eccezionale dell'amministratore tecnico: motivato, limitato, a tempo, approvato da un soggetto diverso, registrato, revocato a fine intervento. **Progettato, non da implementare ora.**
6. Revoca con effetto immediato sulle richieste successive, anche con token ancora valido.
7. Controllo delle autorizzazioni centralizzato nel backend e comune a tutti i canali; il frontend non è un confine di sicurezza.
8. Separazione dei privilegi PostgreSQL come priorità, **da pianificare e approvare separatamente**, senza modifiche allo staging in questa fase.
9. RLS esclusa dalla prima implementazione, salvo nuova decisione.
10. Backup con ripristino **effettivamente provato** prima di qualsiasi modifica strutturale; rollback concretamente eseguibile; nessuna migrazione sullo staging condiviso o in produzione senza approvazione separata.
11. Fornitore email non ancora scelto; interfaccia applicativa indipendente dal fornitore; mittente simulato nei test.
12. Collegamento Telegram solo dopo l'autenticazione dell'account applicativo, con codice monouso, a scadenza, legato allo scopo e all'ID numerico Telegram. Il possesso di un'email non equivale all'identità legale.
13. Tutte le durate di conservazione sono **proposte**, non regole approvate.
14. Il primo pilota non richiede un amministratore di rete reale; il modello lo deve supportare.

## B. Punti ancora da decidere

| # | Decisione | Dove |
| :-: | :--- | :--- |
| D1 | Organizzazione unica con tipo e relazioni (proposta) | §1 |
| D2 | Consulente come persona con deleghe, senza appartenenza all'azienda cliente | §2.2 |
| D3 | Beneficiari delle deleghe a organizzazioni: elenco nominativo approvato dal concedente; durata massima delle deleghe | §2.4 |
| D4 | Soglia minima ed elenco degli indicatori aggregati per le reti | §1.3 |
| D5 | Esportazione: perimetri per ruolo **e canale** (proposta diversa dall'attuale) | §3.3 |
| D6 | C2 — visibilità delle pratiche in chat: proposta «vista predefinita ristretta, mai più ampia del permesso» | §3.4 |
| D6b | C3 — regole di cancellazione R1–R13 e correzione dei file orfani | §3.5 |
| D5b | Export pianificato su Telegram: opzioni a–d, raccomandata b poi d | §3.3 |
| D14 | MF0: protezione del database ripristinato (Opzione A, allegati esclusi, preferita dal proprietario). Raccomandata 2-R (sostituzione casuale a flusso) sul PC attuale; alternativa disco esterno cifrato; accettazione dei rischi residui di §10.4 | §10.3–§10.11 |
| D7 | Strategia di revoca (verifica a ogni richiesta, token 10 min, rinnovo ruotato) | §5 |
| D8 | Recupero degli account con email segnaposto o non accessibile; fusione di account | §4.3 |
| D9 | Approvatore e durata massima dell'accesso eccezionale | §7 |
| D10 | Durate di conservazione e trattamento dell'audit alla cancellazione di un'organizzazione (con verifica legale e privacy) | §8 |
| D11 | Fornitore email | §13 |
| D12 | Piano di separazione dei ruoli PostgreSQL (MF1) | §6 |
| D13 | Autorizzazione di MF0 e, separatamente, di MF2 | §10, §11, §14 |

---

## 0. Situazione attuale verificata

### 0.1 Rapporto tra `User.tenantId` e `user_tenant`

| Elemento | Fatto | Riferimento |
| :--- | :--- | :--- |
| `User.tenantId` | **[V]** Unica fonte di verità dell'appartenenza: ogni utente appartiene a una sola azienda; il ruolo è sull'utente | `prisma/schema.prisma` (model `User`) |
| `user_tenant` | **[V]** Scritta all'adesione con invito e al provisioning, **mai letta** per autenticazione o permessi; `user_id` di tipo testo senza chiave esterna | schema (model `UserTenant`); `src/core/tenant/tenant.invite.store.ts` (`bindUserToTenant`); chiamata da `tenant.provisioning.ts` r. 67, `telegram.bot.ts` r. 66, `whatsapp.channel.ts` r. 113 |
| Coerenza nei dati di staging | **[V]** 1 azienda, 2 utenti, 2 righe `user_tenant` coerenti, nessun utente senza riga, nessun account Telegram in più aziende, 1 email segnaposto (`@local.invalid`), 2 allegati, 3 voci di audit | conteggi in transazione di sola lettura, 29/10/2026 |
| Trigger di coerenza | **[V]** `enforce_user_tenant_match()` su `practice` e `audit_log` legge `user.tenant_id` | `prisma/migrations/20261026110000_phase1_identity_and_isolation/migration.sql` |
| Unicità Telegram | **[V]** `@@unique([tenantId, telegramId])` | schema |
| Produzione | **[V]** Non esiste | — |

### 0.2 Punti del codice che dipendono dal modello attuale

| Punto | Dipendenza | Riferimento |
| :--- | :--- | :--- |
| Risoluzione utente Telegram | **[V]** Prende l'utente più recente con quell'ID: con più aziende non c'è scelta | `src/core/tenant/tenant.store.ts` (`getTenantByTelegramUserAsync`, ~r. 109) |
| Inviti | **[V]** Codice permanente, riutilizzabile, crea sempre un MEMBER | `tenant.invite.store.ts`; `src/data/repositories/user.repository.ts` (`ensureTelegramUser`, r. 67-98) |
| WhatsApp | **[V]** Identità legata a utente e azienda | `whatsapp.channel.ts` (~r. 113), `whatsapp-identity.repository.ts` (~r. 74) |
| Provisioning | **[V]** Azienda, primo ADMIN, codice invito | `tenant.provisioning.ts` (r. 59-67) |
| Proprietario di pratica e audit | **[V]** Verifica via `user.tenantId` | `practice.repository.ts` (~r. 59), `audit.repository.ts` (~r. 40) |
| Destinatari notifiche | **[V]** ADMIN con `telegramId`, calcolati **al momento dell'invio** dagli handler | `outbox.recipients.ts` (r. 24-33, 80); `compliance-reminder.handler.ts` r. 28; `practice-export.handler.ts` r. 46 |
| Scheduler | **[V]** Esegue solo se esiste un ADMIN, scelto come il più vecchio; l'export pianificato copre tutta l'azienda | `scheduler.service.ts` (r. 207-216); `scheduler.tasks.ts` (r. 37-38) |
| Token API | **[V]** HS256 con `tid`, `sub`, `role`; 3600 s predefiniti, 86400 s massimo; nessuna verifica sul database; emessi solo da riga di comando | `src/interface/http/auth/token.ts`, `auth.service.ts`, `src/config/config.ts` r. 36, `scripts/auth.token.ts` |
| Permessi API | **[V]** `AUTH_ROLES`; i MEMBER vedono ed esportano solo le proprie pratiche | `auth.types.ts` r. 29-38; `practice.routes.ts` r. 99, 126, 147, 220 |
| Permessi chat | **[V]** `canAdvance` per i cambi di stato; filtro MEMBER sulle scadenze; i comandi testuali sulle pratiche (crea, stato, elenco, elimina, esporta) **non controllano il ruolo** e operano sempre sulle pratiche dell'utente | `telegram.adapter.ts` r. 72; `compliance.command.ts` r. 77, 82; `conversation.service.ts` ~r. 319; `practice.application.service.ts` (`executeCommand`) |
| Incoerenze tra canali | **[V]** (a) via API ADMIN e OPERATOR vedono ed esportano tutte le pratiche, via chat solo le proprie; (b) via chat **chiunque può cancellare le proprie pratiche** («elimina pratica …»), via API non esiste la cancellazione | come sopra |
| Cancellazione di una pratica | **[V]** Cancellazione **fisica** della riga; le righe degli allegati (con i dati estratti dall'OCR in `ocr_result`) spariscono a cascata, ma **i file restano nello storage, orfani**; audit `PRACTICE_DELETED` con il solo identificativo; in chat il comando «elimina pratica …» agisce **senza conferma**; non esistono stati «annullata» o «archiviata» | `practice.application.service.ts` (`deletePractice`, r. 238-262); `practice.repository.ts` (`deletePracticeById`, r. 301-312); schema (`PracticeStatus`, `PracticeAttachment` `onDelete: Cascade`) |
| Eventi di audit | **[V]** Solo 5 tipi: creazione, cambio di stato e cancellazione di pratiche; creazione e chiusura di scadenze. **Non** registrati: esportazioni manuali (API e chat), caricamento allegati, azioni eseguite tramite AI, login, collegamenti | ricerca di `eventType` in `src/` |
| Stato della conversazione | **[V]** Chiave primaria `user_id` | schema (`ConversationState`) |
| Chiavi esterne verso `user` | **[V]** `practice`, `audit_log`, `compliance_deadline`, `whatsapp_identity`, `conversation_state`, `ai_trace` | schema |
| Servizio centrale | **[V]** Nessun controllo di ruolo | `practice.application.service.ts` |

### 0.3 File, processi, database

| Elemento | Fatto | Riferimento |
| :--- | :--- | :--- |
| Storage | **[V]** Letture e cancellazioni vincolate al prefisso dell'azienda; storage locale in `.runtime/storage`, **condiviso** tra sviluppo e staging sullo stesso PC | `storage.service.ts` r. 25, 32-46; `s3.storage.ts` r. 53-70 |
| Download | **[V]** Nessun endpoint di download, nessun URL di file | `practice.routes.ts` |
| Processi in background | **[V]** Scheduler, conservazione tracce AI, dispatcher outbox | `src/index.ts` r. 280-294 |
| Ruolo PostgreSQL | **[V]** Staging: superutente, `BYPASSRLS`, proprietario delle tabelle; CI: utente `postgres` | verifica in sola lettura 29/10/2026; `.github/workflows/ci.yml` |
| Audit | **[V]** Immutabile via trigger, ma `ON DELETE CASCADE` dall'azienda: un'azienda con audit non è cancellabile | migrazione `20260317195000_audit_log_immutable`; schema |
| Esportazione | **[V]** CSV con **nome della pratica e data di creazione**; filtri oggi/mese/anno/tutto | `practice.application.service.ts` (`exportPractices`, r. 414-447) |
| Backup | **[V]** Nessuna procedura né prova di ripristino | — |

---

## 1. Modello organizzativo [P] — D1

### 1.1 Un'unica entità organizzazione

La tabella `tenant` diventa la tabella delle organizzazioni, con campo **tipo**: `COMPANY`, `NETWORK`, `CONSORTIUM`, `TRADE_ASSOCIATION`, `ASSOCIATION`, `PROFESSIONAL_FIRM`, `OTHER`; più `status` (`ACTIVE`, `SUSPENDED`, `DEACTIVATED`, `PENDING_DELETION`) e date di disattivazione e cancellazione.

- Tutte le tabelle di dati restano legate a `tenant_id`: l'isolamento attuale continua a valere.
- Qualsiasi organizzazione può avere propri dati e propri membri.
- Nessuna tabella per tipo: il tipo abilita solo relazioni e funzioni.

### 1.2 Relazioni

`organization_relation` (`parent_org_id`, `child_org_id`, `relation_type` = `MEMBER_OF`, `status` `PENDING/ACTIVE/ENDED`, `requested_by`, `confirmed_by`, date). Molti-a-molti. L'adesione è confermata da un ORG_ADMIN dell'azienda.

Una relazione abilita solo: anagrafica minima dell'aderente, inclusione negli aggregati, possibilità per l'azienda di concedere deleghe. **Mai permessi sui dati.**

### 1.3 Statistiche aggregate — D4

- Solo indicatori di un elenco chiuso approvato.
- Soglia minima proposta: **5 aziende** per valore; sotto soglia «non disponibile».
- Periodi e categorie fissi, nessun filtro libero che consenta differenze tra interrogazioni.
- Calcolo lato server; nessun dato di dettaglio al client.

---

## 2. Identità, appartenenze e deleghe [P]

### 2.1 Persona

`user` globale: `email` (unica se presente), `email_verified_at` (possesso della casella, **non** identità legale), `status` (`ACTIVE/SUSPENDED/DISABLED`), `auth_version`, `platform_role` (`NONE/PLATFORM_ADMIN`). I campi attuali restano fino alla pulizia (§9).

### 2.2 Appartenenze — D2

`membership` (evoluzione di `user_tenant`): `user_id`, `org_id`, `role` (`MEMBER/OPERATOR/ORG_ADMIN`), `status` (`ACTIVE/SUSPENDED/REVOKED`), permessi aggiuntivi espliciti (es. esportazione dell'organizzazione per un OPERATOR, §3.3), chi ha invitato, revoca con autore e motivo.

Il **consulente non ha appartenenza** all'azienda cliente: riceve deleghe. Può appartenere al proprio studio (`PROFESSIONAL_FIRM`).

### 2.3 Identità di canale

`channel_identity`: `user_id`, `channel`, `external_id` (ID numerico Telegram, numero WhatsApp), `verified_at`, `last_used_at`, `revoked_at`, `revoked_by`. Unica tra quelle attive per `(channel, external_id)`.

### 2.4 Deleghe e beneficiari effettivi — D3

`access_grant`:

| Campo | Contenuto |
| :--- | :--- |
| `grantor_org_id` | organizzazione che concede |
| `grantee_type` | `USER` oppure `ORGANIZATION` |
| `grantee_user_id` / `grantee_org_id` | soggetto autorizzato |
| `scope` | tipi di dato ed eventuale elenco di oggetti o categorie |
| `operations` | `READ`, `CREATE`, `UPDATE`, `APPROVE`, `DELETE`, `EXPORT` (ciascuna esplicita) |
| `valid_from`, `valid_until` | obbligatoria una scadenza; massimo proposto 12 mesi, rinnovabile |
| `status` | `ACTIVE`, `SUSPENDED`, `REVOKED` (scadenza calcolata) |
| `created_by`, `revoked_by`, `revoked_at`, `revocation_reason` | anche nell'audit |

**Beneficiari effettivi di una delega a un'organizzazione** (es. la rete):

1. La delega non vale per «i membri» dell'organizzazione beneficiaria in generale: vale solo per le persone di un **elenco nominativo** `access_grant_beneficiary` (`grant_id`, `user_id`, `status`, `approved_by`, `approved_at`).
2. L'elenco è **approvato dall'organizzazione che concede**. L'organizzazione beneficiaria può solo proporre nomi.
3. Un nuovo amministratore o membro dell'organizzazione beneficiaria **non riceve nulla** finché il concedente non lo approva: le variazioni dei membri non ampliano mai l'accesso.
4. Se una persona lascia l'organizzazione beneficiaria o ne perde il ruolo richiesto, il suo accesso cessa automaticamente.
5. Accesso consentito solo se, insieme:
   - la delega è attiva e non scaduta;
   - il beneficiario è approvato e attivo;
   - la persona è attiva e, per deleghe a organizzazioni, membro attivo dell'organizzazione beneficiaria;
   - l'oggetto e l'operazione rientrano in ambito e operazioni.
6. Regole di concessione:
   - solo chi ha `grant.issue` nell'organizzazione concedente;
   - nessuno può concedere a sé stesso;
   - un amministratore di rete non può creare deleghe sui dati di un'azienda in cui non è ORG_ADMIN.
7. Avviso al concedente prima della scadenza; elenco delle deleghe attive consultabile dal concedente in ogni momento.
8. **Confermato dal proprietario del progetto (29/10/2026)**: le deleghe a organizzazioni restano limitate ai beneficiari nominativi approvati; nuovi membri o amministratori non acquisiscono accesso automaticamente.

### 2.5 Organizzazione attiva

API e dashboard: organizzazione indicata a ogni richiesta e verificata. Chat: scelta automatica con una sola appartenenza, altrimenti `/azienda`; `conversation_state` per `(user_id, org_id)`.

---

## 3. Matrice dei permessi [P]

### 3.1 Principi

- Profili = insiemi di **permessi espliciti** gestiti dal servizio di autorizzazione; deleghe e permessi aggiuntivi sono dati, non controlli sparsi.
- Perimetri: **proprie** (create dalla persona o a lei assegnate), **org** (tutta l'organizzazione), **delega** (solo ambito e operazioni della delega).
- **Approvazione**: cambi di stato che validano, inviano o completano una pratica; conferma delle proposte dell'AI.
- L'AI non concede permessi: ogni azione proposta passa dal servizio di autorizzazione.

### 3.2 Matrice

Legenda: **O** = org · **P** = proprie · **D** = solo se la delega include l'operazione · **+** = solo con permesso aggiuntivo concesso dall'ORG_ADMIN · **—** = negato

| Area | Operazione | MEMBER | OPERATOR | ORG_ADMIN | CONSULENTE | ADMIN DI RETE | ADMIN TECNICO |
| :--- | :--- | :-: | :-: | :-: | :-: | :-: | :-: |
| Organizzazione | Lettura anagrafica propria | O | O | O | — | O (rete) | tecnica |
| | Anagrafica minima aderenti | — | — | — | — | O | tecnica |
| | Amministrazione (impostazioni, integrazioni) | — | — | O | — | O (rete) | — |
| Utenti e appartenenze | Lettura | — | — | O | — | O (rete) | tecnica |
| | Inviti, sospensioni, revoche, ruoli | — | — | O | — | O (rete) | solo primo ORG_ADMIN |
| Pratiche | Lettura (permesso; la vista predefinita in chat è più ristretta, §3.4) | P | O | O | D | D | — |
| | Creazione | P | O | O | D | D | — |
| | Modifica | P | O | O | D | D | — |
| | Approvazione | — | O | O | D | D | — |
| | Richiesta di cancellazione (§3.5) | P | O | O | D | — | — |
| | Annullamento (stato «annullata», §3.5) | P (solo in bozza) | O (non inviate) | O | D | — | — |
| | Archiviazione (§3.5) | — | O | O | — | — | — |
| | Cancellazione effettiva (§3.5) | — | — | O (con conferma e verifiche) | — | — | — |
| | Esportazione (per canale, §3.3) | P | P, O+ | O | D | D | — |
| Documenti e allegati | Lettura e download | P | O | O | D | D | — |
| | Caricamento | P | O | O | D | D | — |
| | Modifica dei dati estratti | P | O | O | D | D | — |
| | Cancellazione effettiva di un documento (§3.5) | — | — | O (con conferma e verifiche) | — | — | — |
| | Esportazione dei file | — | — | O | D | D | — |
| Scadenze | Lettura | P | O | O | D | D | — |
| | Creazione, modifica, chiusura | — | O | O | D | — | — |
| AI | Uso (entro i propri permessi) | P | O | O | D (sola lettura) | — | — |
| | Tracce AI (metadati) | — | O | O | — | — | tecnica |
| Audit | Lettura | — | — | O | — | O (rete) | eventi di sistema |
| Deleghe | Concessione e revoca | — | — | O | — | — | — |
| | Approvazione dei beneficiari | — | — | O | — | — | — |
| | Lettura delle deleghe ricevute | — | — | — | ✅ | ✅ | — |
| Reti | Richiesta di adesione | — | — | O | — | ✅ | — |
| | Conferma di adesione | — | — | O | — | — | — |
| | Statistiche aggregate | — | — | — | — | ✅ (§1.3) | ✅ |
| Piattaforma | Creazione e sospensione organizzazioni | — | — | — | — | — | ✅ |
| | Accesso eccezionale | — | — | approva | — | — | richiede (§7) |
| Canali | Vedere e revocare i propri collegamenti | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Revocare i collegamenti dei membri | — | — | O | — | — | — |

«tecnica» = dati tecnici e di stato, mai contenuti. Consulente e admin di rete: senza delega **nessun** accesso ai dati riservati dell'azienda.

### 3.3 Esportazioni per ruolo e canale — D5

**Oggi [V]**

| Export | Chi | Perimetro | Destinatario | Dati inclusi | Registrazione |
| :--- | :--- | :--- | :--- | :--- | :--- |
| API `POST /practices/export` | MEMBER | proprie | chi chiama (risposta HTTP) | CSV: nome della pratica, data di creazione | **nessuna** |
| API `POST /practices/export` | OPERATOR, ADMIN | tutta l'azienda | chi chiama | idem | **nessuna** |
| Chat «esporta …» (Telegram, WhatsApp) | tutti | proprie | file nella chat privata della persona, conservato anche dal servizio di messaggistica | idem | **nessuna** |
| Export pianificato su Telegram | sistema | tutta l'azienda | **tutti** gli ADMIN collegati a Telegram | idem | messaggio in coda (outbox), non voce di audit |
| Export pianificato su webhook | sistema | tutta l'azienda | sistema esterno all'URL configurato per l'azienda (firma HMAC) | idem | messaggio in coda (outbox) |

**Conseguenze**

- Il nome della pratica contiene spesso il nome di una persona: l'export contiene **dati personali**.
- Un file esportato esce dal controllo della piattaforma (dispositivo, cronologia del servizio di messaggistica, sistema esterno): revoca e conservazione non lo raggiungono più.
- Un export dell'intera azienda porta fuori tutti i nomi delle pratiche con un'unica operazione.
- Le esportazioni manuali oggi non lasciano traccia.

**Proposta**

| Export | Chi può | Perimetro | Destinatario | Dati inclusi | Audit |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Manuale via API o dashboard | MEMBER | proprie | la persona autenticata che scarica | nome e data di creazione, come oggi; ogni campo in più richiede una nuova decisione | `EXPORT_GENERATED`: persona, canale, perimetro, filtro, numero di righe (nessun contenuto) |
| | OPERATOR | proprie; tutta l'organizzazione solo con permesso aggiuntivo concesso dall'ORG_ADMIN | idem | idem | idem |
| | ORG_ADMIN | tutta l'organizzazione | idem | idem | idem |
| | Consulente, admin di rete | solo l'ambito di una delega che include `EXPORT` | idem | idem | idem, con riferimento alla delega |
| Manuale via chat | tutti i profili | **solo proprie**, anche per ORG_ADMIN: il file resterebbe nella cronologia del servizio di messaggistica | chat privata della persona collegata | idem | idem, canale chat |
| Pianificato su Telegram | ORG_ADMIN attivi, collegati, che hanno **scelto** di riceverlo | tutta l'organizzazione | chat privata di ciascuno | idem | una voce per consegna, con il destinatario |
| Pianificato su webhook | configurato dall'ORG_ADMIN | tutta l'organizzazione | URL HTTPS configurato | idem | configurazione e ogni consegna |
| File e documenti (futuro) | ORG_ADMIN; delega con `EXPORT` | organizzazione o ambito della delega | solo download autenticato | file originali | idem, con elenco degli oggetti |
| Export completo prima della cancellazione dell'organizzazione (§8.2) | ORG_ADMIN | tutta l'organizzazione | download autenticato | dati e file | idem |

**Decisione aperta D5b — export pianificato su Telegram** (separata da MF0 e MF2; comportamento attuale invariato). Oggi invia il CSV dell'intera azienda a **tutti** gli ADMIN collegati **[V]**, in contrasto con la regola «niente export dell'organizzazione in chat».

| Opzione | Descrizione | Pro | Contro |
| :--- | :--- | :--- | :--- |
| a | Lasciare com'è | nessun lavoro | file dell'intera azienda a tutti gli ADMIN, nella cronologia di Telegram; nessuna scelta individuale |
| b | Transitorio: solo a chi lo sceglie | destinatari espliciti e revocabili | il file resta nella cronologia di Telegram |
| c | Sospendere l'invio del file su Telegram; resta il webhook | nessun file in chat | perdita della funzione fino alla dashboard |
| d | Obiettivo: avviso con collegamento a download autenticato | nessun file in chat; accesso verificato e revocabile | richiede login e download autenticato |

**Opzione b nel dettaglio**

- **Scelta individuale**: ogni ORG_ADMIN attiva l'invio per sé, per la propria organizzazione; predefinito **disattivato**; registrata con data e autore.
- **Revocabile** in ogni momento dalla persona (comando in chat o API) e dall'ORG_ADMIN per gli altri; si interrompe automaticamente se la persona perde il ruolo, l'appartenenza o il collegamento Telegram.
- **Controllo a ogni consegna** (destinatari calcolati all'invio **[V]**): persona attiva, ORG_ADMIN attivo, collegamento attivo, scelta attiva.
- **Avviso del rischio** al momento dell'attivazione: il file resterà nella cronologia di Telegram.
- **Dati inviati**: CSV con nome della pratica e data di creazione (come oggi), messaggio con periodo e numero di pratiche; nessun campo in più.
- **Registrazione**: una voce di audit per consegna (`EXPORT_DELIVERED`: organizzazione, destinatario, canale, identificativo del messaggio in coda, periodo, numero di righe, esito), senza contenuto; voci per attivazione e revoca della scelta.
- **Conseguenze**: gli ADMIN che non attivano la scelta smettono di ricevere il file; va comunicato prima del cambio.
- **Misura facoltativa**: cancellazione automatica del messaggio da parte del bot dopo 24 ore (consentita da Telegram nelle chat private entro 48 ore **[NV]**); non toglie il file a chi lo ha già scaricato.

**Opzione d: condizioni e conseguenze**

- Richiede il login (MF6) e un endpoint di download autenticato con verifica dei permessi (MF5).
- Collegamento personale, monouso, valido al massimo 15 minuti, inutilizzabile senza sessione autenticata della stessa persona.
- Anteprima dei collegamenti disattivata nel messaggio (Telegram altrimenti scarica la pagina dai suoi server).
- File generato al momento del download con i dati e i permessi di quel momento: revoche e cancellazioni hanno effetto; il contenuto può differire dall'istante pianificato (va detto nel messaggio).
- Audit della generazione e di ogni download.
- Conseguenze: un passaggio in più per l'utente (login nel browser o, in futuro, nella Mini App); nessun file nella cronologia di Telegram.

**Raccomandazione**: b fino alla disponibilità di MF5 e MF6, poi d. Il cambio da «tutti gli ADMIN» a «chi lo sceglie» va in MF8 con le altre regole di export.

**Deleghe**: confermato che una delega a un'organizzazione vale solo per i **beneficiari nominativi approvati** dal concedente (§2.4); nuovi membri o amministratori dell'organizzazione beneficiaria non ottengono alcun accesso, neanche all'export, senza approvazione.

### 3.4 C2 — Visibilità delle pratiche in chat [P] — D6

**Principio**: il **permesso** è unico per tutti i canali e deciso dal servizio di autorizzazione. Ogni canale può applicare una **vista predefinita più ristretta** e limitare alcune operazioni, **mai** ampliarle oltre il permesso. In chat (telefono, anteprime delle notifiche, cronologia conservata dal servizio di messaggistica) conviene mostrare il minimo per default.

| Operazione | Profilo | Permesso (tutti i canali) | Chat oggi [V] | Chat proposta |
| :--- | :--- | :-: | :--- | :--- |
| Elenco pratiche | MEMBER | P | proprie | proprie (invariato) |
| | OPERATOR | O | proprie | **predefinito: proprie**; pratiche dell'organizzazione solo con richiesta esplicita (es. «pratiche dell'azienda»), risultati paginati |
| | ORG_ADMIN | O | proprie | come OPERATOR |
| | Consulente, admin di rete | D | non disponibile | solo con richiesta esplicita e solo l'ambito della delega |
| Stato o dettaglio di una pratica per nome | MEMBER | P | tra le proprie | invariato |
| | OPERATOR, ORG_ADMIN | O | tra le proprie | ricerca prima tra le proprie; tra quelle dell'organizzazione solo con richiesta esplicita, così un nome uguale non porta alla pratica sbagliata |
| Cambio di stato (comando o AI) | OPERATOR, ORG_ADMIN | O | consentito; perimetro da caratterizzare **[NV]** | perimetro del permesso, con conferma quando la pratica non è propria |
| Esportazione | tutti | §3.3 | proprie | proprie (invariato) |
| Cancellazione | §3.5 | §3.5 | chiunque, proprie, senza conferma | §3.5 |

Fino alla decisione esplicita:

- MF2 **non cambia** la vista della chat;
- i test di caratterizzazione descrivono il comportamento attuale in un file marcato «**comportamento attuale, non normativo**»;
- i casi normativi della chat nella matrice attesa restano «da decidere» (`it.todo`), quindi non trasformano il comportamento attuale nella regola futura.

### 3.5 C3 — Ciclo di cancellazione delle pratiche [P] — D6b

**Oggi [V]**: cancellazione fisica immediata, file orfani nello storage, nessuna conferma in chat, nessuno stato intermedio (§0.2).

**Concetti distinti**

| Azione | Effetto | Reversibile | Dati |
| :--- | :--- | :-: | :--- |
| **Richiesta di cancellazione** | registra la richiesta (`deletion_request`: pratica, richiedente, motivo, stato `PENDING/APPROVED/REJECTED/EXECUTED`, decisore, date); non cancella nulla | sì | invariati |
| **Annullamento** | nuovo stato `CANCELLED` (creata per errore, duplicata, rinunciata): leggibile, esclusa dagli elenchi predefiniti, dalle scadenze e dagli export pianificati | sì, da ORG_ADMIN | invariati |
| **Archiviazione** | nuovo stato `ARCHIVED` per pratiche concluse o annullate: sola lettura | sì, da ORG_ADMIN | invariati |
| **Cancellazione effettiva** | rimozione di pratica, allegati (righe **e file nello storage**), dati estratti, riferimenti negli stati di conversazione; voce nel registro delle cancellazioni per i backup | no | rimossi |

**Autorizzazioni per profilo e perimetro**

| Azione | MEMBER | OPERATOR | ORG_ADMIN | Consulente | Admin di rete | Admin tecnico |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: |
| Richiesta di cancellazione | proprie | organizzazione | organizzazione | con delega `DELETE`: solo richiesta | — | — |
| Annullamento | proprie, solo se `CREATED` | organizzazione, se non `SUBMITTED`/`COMPLETED` | organizzazione | con delega `UPDATE` | — | — |
| Archiviazione | — | organizzazione | organizzazione | — | — | — |
| Approvazione della richiesta | — | — | organizzazione (non la propria richiesta, se esiste un altro ORG_ADMIN) | — | — | — |
| Cancellazione effettiva | — | — | organizzazione, con conferma | — | — | — |

**Quando la cancellazione fisica non è appropriata**

- pratiche `SUBMITTED` o `COMPLETED`: sono la prova di un adempimento → archiviazione;
- pratiche con documenti soggetti a conservazione (es. fiscali) finché non scade il periodo indicato dall'organizzazione ⚖️ → archiviazione;
- pratiche oggetto di contestazione o di blocco legale (funzione futura) → nessuna cancellazione;
- adatta invece a bozze, duplicati ed errori, e alle richieste di cancellazione dei dati personali gestite dall'ORG_ADMIN come titolare, dopo la verifica degli obblighi ⚖️.

**Esecuzione**

1. Conferma esplicita: in chat un secondo messaggio di conferma entro 2 minuti (con il nome della pratica); via API un parametro di conferma.
2. Transazione unica: verifica delle condizioni, cancellazione delle righe, voce di audit (solo identificativi), registro delle cancellazioni.
3. File cancellati dopo il commit da un processo con ripetizione e verifica: un errore lascia un compito tracciato, non un file dimenticato.
4. Audit di ogni passaggio: richiesta, decisione, annullamento, archiviazione, cancellazione.

**File orfani esistenti**: oggi i file delle pratiche cancellate restano nello storage **[V]**. Proposta: correzione nel ciclo sopra più uno script di riconciliazione che elenca i file orfani; la loro cancellazione solo con approvazione.

**Regole di cancellazione proposte in forma definitiva (da approvare) — D6b**

| # | Regola |
| :-: | :--- |
| R1 | Nessuna cancellazione fisica senza conferma esplicita e separata dalla richiesta (in chat: secondo messaggio entro 2 minuti con il nome della pratica; via API: parametro di conferma). |
| R2 | L'AI non esegue mai cancellazioni: una richiesta in linguaggio naturale può al massimo produrre una **richiesta di cancellazione** o un **annullamento**, sempre con conferma. |
| R3 | MEMBER: può annullare solo pratiche proprie in stato `CREATED`; per tutto il resto può solo chiedere la cancellazione. |
| R4 | OPERATOR: può annullare pratiche dell'organizzazione non `SUBMITTED`/`COMPLETED` e archiviare pratiche concluse o annullate; non cancella fisicamente. |
| R5 | ORG_ADMIN: unico profilo che cancella fisicamente, solo nell'organizzazione; se esiste un altro ORG_ADMIN, non approva le proprie richieste. |
| R6 | Consulente: solo richiesta di cancellazione o annullamento, e solo con una delega che include l'operazione; admin di rete e admin tecnico: nessuna cancellazione. |
| R7 | Cancellazione fisica **ammessa** solo per pratiche `CREATED`, `FAILED` o `CANCELLED` senza documenti soggetti a conservazione, oppure per esercitare un diritto dell'interessato dopo verifica degli obblighi ⚖️. |
| R8 | Cancellazione fisica **esclusa** per pratiche `SUBMITTED`, `COMPLETED`, `ARCHIVED` o con documenti soggetti a conservazione finché non scade il periodo indicato dall'organizzazione ⚖️: si archivia. |
| R9 | La cancellazione fisica rimuove in un'unica operazione tracciata: riga della pratica, allegati e **file nello storage**, dati estratti, riferimenti negli stati di conversazione; le scadenze collegate vengono chiuse con motivo. |
| R10 | Ogni passaggio (richiesta, decisione, annullamento, archiviazione, cancellazione) produce una voce di audit con soli identificativi, autore, ruolo, canale e motivo. |
| R11 | Ogni cancellazione fisica entra nel registro delle cancellazioni, usato per ripeterle dopo un eventuale ripristino da backup. |
| R12 | Cancellare un singolo documento segue le stesse regole della pratica a cui appartiene. |
| R13 | I file orfani esistenti vengono solo elencati da uno script di riconciliazione; la loro cancellazione richiede un'approvazione specifica. |

**Stato delle regole R1–R13**: **proposta non approvata**. Punti che richiedono verifica legale o privacy ⚖️ prima dell'approvazione:

| # | Tema | Questione da verificare | Regole interessate |
| :-: | :--- | :--- | :--- |
| L1 | Conservazione documentale | Obblighi civilistici e fiscali (es. art. 2220 c.c., art. 22 DPR 600/1973, art. 39 DPR 633/1972) **[NV]**: spettano all'azienda; la piattaforma non è un sistema di conservazione digitale a norma e non deve presentarsi come archivio legale; chi decide i periodi e come vengono comunicati | R7, R8 |
| L2 | Cancellazione dei dati personali | Diritto alla cancellazione (art. 17 GDPR) e sue eccezioni (obbligo legale, difesa di un diritto); ruoli di titolare (azienda) e responsabile (piattaforma); tempi di riscontro (art. 12) | R7, R9 |
| L3 | Allegati con dati di terzi | Documenti che contengono dati di persone diverse dall'utente (es. nomi su fatture o ricevute): base giuridica, minimizzazione, chi risponde alle richieste | R9, R12 |
| L4 | Backup | Ammissibilità della permanenza dei dati cancellati nei backup fino alla loro scadenza, con accesso limitato e **ripetizione delle cancellazioni dopo un ripristino**; informativa e registro dei trattamenti | R11 |
| L5 | Registro delle cancellazioni | Deve contenere solo identificativi, per non reintrodurre i dati cancellati; durata della sua conservazione | R11 |
| L6 | Audit | Durata (proposta 5 anni) e conciliazione con le richieste di cancellazione; contenuto limitato agli identificativi | R10 |
| L7 | File orfani esistenti | File di pratiche già cancellate ancora nello storage **[V]**: valutare se occorre intervenire e con quali tempi | R13 |
| L8 | Pratiche inviate a enti | Se una pratica `SUBMITTED` o `COMPLETED` debba restare come prova dell'adempimento e per quanto | R8 |

Fino all'approvazione delle regole: **comportamento attuale invariato**, documentato dai test di caratterizzazione (compreso il file che resta nello storage, segnalato come difetto noto). L'implementazione richiede una migrazione (nuovi stati, tabella delle richieste): micro-fase dedicata MF13 (§15).

---

## 4. Autenticazione, recupero e collegamento Telegram [P]

### 4.1 Login con codice monouso via email

1. `POST /auth/login/start` con l'email: risposta e tempi **identici** in ogni caso. Se l'utente è attivo, sfida con codice di 6 cifre e link equivalente, **10 minuti**, salvati come hash.
2. `POST /auth/login/verify`: massimo **5 tentativi** per sfida, limiti per email e per IP, consumo **atomico** (una sola volta).
3. Sessione nel database; token di accesso **10 minuti** con `sub`, `sid`, `ver` (nessun ruolo né organizzazione); token di rinnovo casuale, hash nel database, **ruotato a ogni uso**, riuso → revoca della sessione.
4. Registrazione di ogni login riuscito e fallito.

### 4.2 Inviti

Nominativi (email, organizzazione, ruolo iniziale, scadenza proposta 7 giorni, creatore), monouso, revocabili. Accettazione solo verificando **la stessa email**. Persona già esistente → nuova appartenenza. I codici invito permanenti attuali vengono disattivati dopo la migrazione.

### 4.3 Recupero degli account — D8

| Caso | Procedura | Protezioni |
| :--- | :--- | :--- |
| **A. Account con email segnaposto** (creato con invito Telegram/WhatsApp), canale ancora controllato | Il bot chiede di aggiungere un'email: la richiesta deve arrivare **dallo stesso ID numerico** già collegato; codice monouso inviato alla nuova email; verificato → email associata | Doppia prova: controllo del canale già collegato + possesso della casella. Nessuna associazione dal web o da un altro account |
| A1. L'email indicata appartiene già a un'altra persona | **Nessuna fusione automatica.** La fusione richiede le due prove e l'approvazione di un ORG_ADMIN di ogni organizzazione coinvolta; registrata nell'audit | Evita che chi conosce un'email si appropri di un account |
| **B. Account con email segnaposto, canale non più controllato** | Nessun recupero autonomo. L'ORG_ADMIN invita la persona su un'email verificata; il vecchio account viene disattivato; le pratiche a lei assegnate vengono riassegnate dall'ORG_ADMIN (registrato) | Nessun collegamento ereditato dal vecchio account |
| **C. Email verificata non più accessibile** | Come B: nuovo invito, disattivazione del vecchio account, riassegnazione | Avviso all'indirizzo precedente, se possibile |
| **D. Unico ORG_ADMIN che ha perso l'accesso** | Richiesta documentata del legale rappresentante dell'organizzazione, verificata fuori dalla piattaforma; esecuzione da parte dell'admin tecnico con **doppio controllo** (secondo admin tecnico o approvazione documentale); mai via chat | Registrata nell'audit; notifica a tutti gli altri membri |

Il possesso dell'email dimostra il controllo della casella, non l'identità legale. Per i ruoli ORG_ADMIN, chi invita attesta l'identità della persona; una verifica legale (es. SPID/CIE) resta fuori dalla Fase 1.

### 4.4 Collegamento Telegram

Requisiti:

- codice monouso, **10 minuti**, salvato come hash, legato allo **scopo** `TELEGRAM_LINK`, alla **persona** autenticata e, nella variante A, all'**ID numerico** Telegram richiedente;
- massimo 5 tentativi; limiti per ID Telegram;
- identità = ID numerico del mittente, mai username o nome;
- il bot opera **solo in chat private**.

**Variante A (pilota)**: `/accedi` → email → codice inviato per email, valido solo se digitato dallo stesso ID Telegram → verifica dell'account e collegamento nella stessa operazione → email di conferma con istruzioni per revocare.

**Variante B (con dashboard o Mini App)**: la persona autenticata genera codice o link `t.me/<bot>?start=<token>`; il bot collega l'ID del mittente.

**Verifica atomica** (un'unica transazione):

1. `UPDATE` della sfida impostando `consumed_at`, con condizioni nella stessa istruzione: scopo corretto, non consumata, non scaduta, tentativi < 5, ID Telegram uguale a quello registrato (variante A), hash del codice corrispondente; `RETURNING user_id`.
2. Nessuna riga → incremento dei tentativi in un'operazione separata e risposta generica.
3. `INSERT` in `channel_identity`: il vincolo di unicità impedisce un secondo collegamento attivo dello stesso ID → annullamento dell'intera transazione.
4. `INSERT` nell'audit (persona, canale, ID esterno in forma ridotta, esito).
5. Commit; poi email di conferma.

**Gestione**: `/collegamenti` e API per vedere i collegamenti; revoca dalla persona (`/scollega` o API) o dall'ORG_ADMIN per i membri; ogni revoca registrata. WhatsApp con lo stesso schema.

---

## 5. Revoca [P] — D7

**Scelta**: verifica dello stato nel database a ogni operazione, token di accesso di 10 minuti senza ruoli, rinnovo revocabile e ruotato.

Motivi legati al codice: autenticazione HTTP già concentrata in un hook per richiesta **[V]** (`auth.hook.ts`); identità chat già risolta a ogni messaggio **[V]**; volumi bassi (nel test di carico del 29/10/2026 la lettura di una pratica restava sotto 140 ms al 95° percentile con 25 richieste simultanee **[V]**). La sola durata breve dei token lascerebbe fino a 10 minuti di accesso dopo la revoca.

Verifiche a ogni operazione: identità; sessione non revocata e `ver = auth_version`; persona attiva; organizzazione attiva; appartenenza attiva con il permesso, oppure delega e beneficiario validi; accesso all'oggetto specifico. Nessuna cache iniziale.

| Area | Comportamento |
| :--- | :--- |
| Download | Endpoint autenticato che verifica il permesso e trasmette il file; nessun URL pubblico; eventuali URL firmati S3 solo dopo l'autorizzazione e con scadenza ≤ 60 s |
| Chat | Verifica a ogni messaggio; stati in sospeso annullati alla revoca |
| Outbox | Destinatari già calcolati all'invio **[V]**: la query deve filtrare persone, appartenenze e collegamenti attivi con il permesso |
| Scheduler | Identità di sistema limitata all'organizzazione, non «il primo ADMIN» **[V]** oggi |
| Connettori | Identità tecnica per connettore con permessi espliciti |

---

## 6. Privilegi PostgreSQL e RLS [P] — D12

Situazione **[V]**: superutente proprietario con `BYPASSRLS`; può modificare lo schema e disattivare i trigger, compreso quello dell'audit.

| Ruolo proposto | Privilegi |
| :--- | :--- |
| `sinfonia_owner` | proprietario; solo migrazioni |
| `sinfonia_app` | DML sulle tabelle applicative; su `audit_log` solo `INSERT`/`SELECT`; nessun DDL, `TRUNCATE`, superuser, `BYPASSRLS` |
| `sinfonia_backup` | lettura per `pg_dump` |
| `sinfonia_retention` (facoltativo) | cancellazione degli audit scaduti tramite funzione dedicata |

Pianificazione in MF1 (§15), con approvazione separata e nessuna modifica allo staging finché non autorizzata.

**RLS**: esclusa dalla prima implementazione (decisione confermata). Motivi: contesto da impostare in ogni transazione con Prisma e il pool (rischio di contaminazione tra richieste se impostato a livello di sessione); costo per query; processi trasversali che richiederebbero un client privilegiato; duplicazione nel database della logica delle deleghe. Condizioni per una futura adozione limitata (`practice`, `practice_attachment`, `audit_log`): `FORCE ROW LEVEL SECURITY`, policy deny-by-default, contesto solo `SET LOCAL`, client privilegiato isolato e verificato in CI, test di contesto assente, connessione riutilizzata, richieste concorrenti e prestazioni.

---

## 7. Accesso eccezionale [P] — D9 — progettato, non da implementare

1. **Richiesta** dell'admin tecnico: organizzazione, motivo concreto con riferimento, ambito minimo, operazioni (di norma lettura), durata (massimo proposto 4 ore).
2. **Approvazione** da un ORG_ADMIN dell'organizzazione; in sua assenza da un secondo admin tecnico con notifica all'organizzazione. Mai il richiedente.
3. **Concessione** come delega temporanea `BREAK_GLASS` nello stesso servizio di autorizzazione.
4. **Uso** registrato accesso per accesso; notifica all'apertura e alla chiusura.
5. **Chiusura** automatica alla scadenza o anticipata; riepilogo all'organizzazione.

**Limite dichiarato**: chi possiede credenziali di proprietario del database o accesso all'infrastruttura può aggirare i controlli applicativi; l'architettura attuale non consente un controllo indipendente contro questa figura. Mitigazioni: MF1; copia dell'audit su storage append-only esterno (es. S3 Object Lock in UE) **[NV]**; accesso all'infrastruttura nominativo con registro del fornitore; facoltativo `pgaudit`.

---

## 8. Conservazione, audit e cancellazione [P] — D10

**Tutte le durate sono proposte da valutare.** ⚖️ = richiede verifica legale o privacy.

Premessa ⚖️: per i dati delle aziende SinfonIA è presumibilmente **responsabile del trattamento** e l'azienda **titolare**; da confermare con un consulente privacy e formalizzare in un DPA, insieme ai sub-responsabili (hosting, OpenAI, fornitore email, Meta) e ai trasferimenti extra UE (OpenAI) **[NV]**.

| Categoria | Contenuto | Finalità | Proposta (non approvata) | Verifica | Cancellazione logica | Cancellazione effettiva | Nei backup |
| :--- | :--- | :--- | :--- | :-: | :--- | :--- | :--- |
| Dati operativi | pratiche, payload, scadenze | servizio | durata del contratto con l'organizzazione | ⚖️ | disattivazione dell'organizzazione | fine contratto + restituzione dei dati + periodo di ripensamento (proposto 30 giorni) | fino a scadenza del backup |
| Documenti | dati estratti e metadati dei documenti | servizio, adempimenti dell'azienda | decisa dal titolare; predefinito durata del contratto | ⚖️ conservazione fiscale (es. art. 2220 c.c., 10 anni) è obbligo dell'azienda, non necessariamente della piattaforma **[NV]** | come sopra | come sopra, dopo esportazione | idem |
| Allegati (file) | foto, PDF nello storage | come documenti | come documenti | ⚖️ | come sopra | file nello storage, poi riga nel database | copia file di backup fino a scadenza |
| Dati estratti dall'AI | campi letti dall'OCR, verifiche | compilazione pratiche | seguono il documento | ⚖️ | con il documento | con il documento | idem |
| Identità | persona, email, collegamenti di canale | accesso | finché esiste un'appartenenza o delega attiva; poi 12 mesi, quindi anonimizzazione | ⚖️ | disattivazione | anonimizzazione (email, ID di canale) | idem |
| Appartenenze e deleghe | ruoli, deleghe, beneficiari, revoche | prova delle autorizzazioni | come l'audit | ⚖️ | stato `REVOKED` | con l'audit | idem |
| Inviti, sfide, codici, sessioni | codici monouso (hash), sessioni | autenticazione | inviti 30 giorni dopo scadenza; sfide 24 ore; sessioni alla scadenza | — | — | automatica | idem |
| Stato conversazioni | ultima pratica, benvenuto (nessun testo dei messaggi **[V]**) | continuità | 90 giorni di inattività | — | — | automatica | idem |
| Coda messaggi (outbox) | contenuto delle notifiche | consegna | 30 giorni dopo la consegna o il fallimento definitivo | — | — | automatica | idem |
| Log di sicurezza | login riusciti e falliti, IP, accessi eccezionali | sicurezza, indagini | 12 mesi | ⚖️ provvedimento del Garante sugli amministratori di sistema (log degli accessi degli amministratori, almeno 6 mesi, inalterabili) **[NV]** | — | automatica | idem |
| Audit operazioni | operazioni, variazioni di permessi, revoche | responsabilità, ricostruzione | 5 anni | ⚖️ nessun obbligo specifico individuato; da motivare | — | solo con procedura di conservazione dedicata (§6) | idem |
| Tracce AI | metadati, nessun testo **[V]** | diagnosi, costi | 90 giorni (già configurato **[V]**) | — | — | automatica **[V]** | idem |
| Backup | copie del database e dei file | ripristino | 30 giorni | ⚖️ da indicare nell'informativa | — | scadenza naturale | — |

### 8.1 Audit e cancellazione dell'organizzazione

Coerenza con l'immutabilità:

- l'audit **non si modifica e non si cancella** con l'organizzazione: chiave esterna `RESTRICT` invece di `CASCADE`; l'organizzazione resta come record minimo (`DELETED`: identificativo e denominazione) finché esistono voci di audit;
- poiché l'audit non può essere corretto né pseudonimizzato dopo la scrittura, **da subito le nuove voci devono contenere solo identificativi**, non nomi, email o contenuti; le 3 voci esistenti sullo staging vanno esaminate ⚖️;
- la cancellazione dell'audit avviene solo alla scadenza, con la procedura e il ruolo dedicati, e viene a sua volta registrata.

### 8.2 Procedura per l'organizzazione

1. **Esportazione** autorizzata (ORG_ADMIN), registrata.
2. **Disattivazione** (logica): accessi bloccati, notifiche sospese, reversibile.
3. **Periodo di ripensamento** (proposto 30 giorni).
4. **Cancellazione effettiva**: file, pratiche, documenti, scadenze, conversazioni, collegamenti, appartenenze, deleghe concesse e ricevute; si conservano solo audit e log di sicurezza fino alla loro scadenza.
5. **Backup**: i dati cancellati restano fino alla scadenza delle copie; un **registro delle cancellazioni** permette di ripeterle dopo un eventuale ripristino.

Da aggiungere ai log: login riusciti e falliti; revoche, sospensioni, cambi di ruolo; deleghe e beneficiari; collegamenti di canale; esportazioni; accessi eccezionali.

---

## 9. Backup, migrazione e rollback [P]

- **Backup**: `pg_dump` cifrato giornaliero e prima di ogni migrazione, più copia dei file; storage UE separato **[NV]**; prova di ripristino trimestrale (procedura in §10).
- **Migrazione M1** (solo aggiunte), **M2** (passaggio), **M3** (pulizia dopo un periodo di verifica): dettagli e rollback come nella versione 2, invariati. M3 solo dopo prova di ripristino e approvazione separata.
- **Verifiche di integrità** prima e dopo: conteggi per tabella, hash degli identificativi, ogni utente con appartenenza e ruolo equivalente, coerenza pratica-appartenenza, unicità dei collegamenti di canale, file presenti con hash identico, nessun orfano, confronto dei permessi effettivi su un campione.
- Script di rollback scritti a mano e provati in CI su una copia; nessuna migrazione sullo staging condiviso senza approvazione separata.

---

## 10. Piano esecutivo MF0 — backup e prova di ripristino — fase 1 eseguita (PR #10), fase 2 non autorizzata

### 10.1 Obiettivo e vincoli

Dimostrare che lo staging si può salvare e ripristinare, misurando i tempi, **senza scritture sullo staging** e **senza dati personali in chiaro scritti in modo persistente sul disco del PC**.

Vincoli del proprietario (29/10/2026):

- BitLocker **non è attivo** **[V]** (dichiarato dal proprietario) e non va attivato; nessuna modifica alla configurazione del PC senza approvazione separata;
- **Opzione A**: database completo dello staging, **allegati reali esclusi** (né copiati né letti);
- il database ripristinato non può contenere dati reali in chiaro sul disco attuale;
- nessuna copia, dump, database, file temporaneo o rapporto con dati reali finché MF0 non è approvato;
- MF0 e MF2 hanno autorizzazioni separate.

### 10.2 Ambiente del PC (letture in sola lettura del 29/10/2026)

| Elemento | Stato | Rilevanza |
| :--- | :--- | :--- |
| File di paging | `C:\pagefile.sys`, gestito automaticamente, **non cifrato** (`EncryptPagingFile = 0`) **[V]** | la memoria di qualsiasi processo può finire su disco in chiaro |
| Dump di memoria in caso di blocco di sistema | `CrashDumpEnabled = 7` (dump automatico della memoria del kernel) in `C:\WINDOWS\MEMORY.DMP` **[V]** | contiene memoria del kernel (anche buffer di rete e pipe), non di norma quella dei processi |
| Dump dei processi (Windows Error Reporting) | `LocalDumps` configurato solo per un programma (`XD.exe`), non per i processi della prova **[V]**; resta il comportamento predefinito di WER (rapporti con minidump in `C:\ProgramData\Microsoft\Windows\WER`, eventuale invio a Microsoft secondo le impostazioni) **[NV]** | in caso di crash di un processo della prova, un minidump può contenere frammenti di memoria |
| Ibernazione e sospensione ibrida | non verificate **[NV]** (richiederebbero `powercfg`) | durante l'ibernazione tutta la memoria viene scritta in `C:\hiberfil.sys` |
| Cartella temporanea | `C:\Users\flavi\AppData\Local\Temp` **[V]** | da controllare prima e dopo la prova |
| Unità | `C:` NTFS fisso; `E:` rimovibile exFAT **[V]**, cifratura non verificata | `E:` **non** va considerata un supporto protetto |
| Sincronizzazione cloud | cartella proposta fuori da OneDrive e Dropbox **[V]**; configurazioni dei client **[NV]** | — |
| Indicizzazione | Windows Search attivo **[V]** | — |

Impostazioni dello staging lette in sola lettura **[V]**: `log_statement = none`, `log_min_error_statement = error`, `log_parameter_max_length_on_error = 0` (i parametri delle query **non** finiscono nei log neanche in caso di errore), `logging_collector = off` (i messaggi del server vanno in `.runtime/pgdata_test/postgres.log`), nessuna sequenza, nessun large object, PostgreSQL 17.6.

### 10.3 Opzioni di protezione

| # | Opzione | Database ripristinato | Memoria, paging, dump | Costi e modifiche | Completezza della prova |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1a | Disco esterno con cifratura hardware | dati **reali**, cifrati a riposo; **in chiaro per qualsiasi processo dell'utente mentre il disco è sbloccato** | come le altre opzioni: paging, dump e ibernazione restano su `C:` | acquisto **[NV]** (indicativamente 80–200 €); nessuna modifica al PC | massima: valori reali ripristinati |
| 1b | Contenitore VeraCrypt | come 1a | come sopra | installazione di software e driver | massima |
| 1c | EFS sulla cartella | come 1a, protetto dalla password di Windows | come sopra | certificato EFS nel profilo | massima |
| 2-P | Ripristino a flusso con **pseudonimizzazione** deterministica (HMAC con chiave) | valori sostituiti da codici deterministici | dati reali solo in memoria | nessuna | dati verificati con impronte; valori reali non riletti |
| **2-R** | Ripristino a flusso con **sostituzione casuale** (mappa in memoria) | **valori diretti e testi liberi sostituiti; identificativi rimappati; date traslate** | dati reali solo in memoria | nessuna | dati verificati con impronte riga per riga; valori reali non riletti |
| 3 | Dati reali in chiaro sul PC | dati reali in chiaro | — | — | **non ammessa** |

**Per il disco esterno cifrato (1a)**: rimarrebbero sul supporto protetto, se il cluster vi è creato, i file dei dati, i WAL, i file temporanei di PostgreSQL (`base/pgsql_tmp`, dentro la cartella dei dati poiché `temp_tablespaces` non è impostato nello staging e non lo sarebbe nel cluster di prova), il log del server, il dump e il manifesto. **Non** rimarrebbero sul supporto: file di paging, dump di memoria, ibernazione, minidump di WER, trascrizioni della sessione dell'assistente (tutti su `C:`). Inoltre, mentre il disco è sbloccato, i dati reali sono leggibili in chiaro da ogni processo dell'utente. 1a protegge quindi il dato **a riposo dopo la prova**, non durante.

### 10.4 Percorso dei dati — opzione 2-R raccomandata

Un unico processo Node («orchestratore») gestisce chiavi e flussi: **nessuna chiave in variabili d'ambiente o su file**; i programmi esterni (`pg_dump`, `pg_restore`, `psql`) sono collegati con pipe anonime create dall'orchestratore. La cifratura usa AES-256-GCM della libreria standard di Node (niente `openssl`, niente chiavi passate a riga di comando).

| # | Passaggio | Dati reali in chiaro transitano in | Possibili scritture su disco | Misure |
| :-: | :--- | :--- | :--- | :--- |
| 1 | Server dello staging (5433) legge i propri file | memoria del server | nessuna nuova: i file dello staging esistono già in chiaro su `C:` (situazione attuale, non introdotta da MF0) | sessione `REPEATABLE READ READ ONLY` |
| 2 | Istantanea di verifica: `COPY … TO STDOUT` di ogni tabella nell'istantanea esportata, letta dall'orchestratore | socket locale, memoria dell'orchestratore | paging; dump del kernel (buffer di rete) in caso di blocco di sistema; minidump WER in caso di crash del processo | per ogni riga si calcola subito l'HMAC e si scarta il testo; nessuna stampa |
| 3 | `pg_dump --snapshot -Fc` → pipe → orchestratore → AES-256-GCM → file | memoria di `pg_dump` e dell'orchestratore, buffer della pipe | **solo il file cifrato**; paging, dump come sopra | il dump non esiste mai in chiaro su disco |
| 4 | File cifrato → orchestratore (decifratura) → pipe → `pg_restore -f -` (genera lo script SQL) → pipe → orchestratore | memoria dell'orchestratore e di `pg_restore`, pipe | `pg_restore` che legge da pipe non usa file temporanei **[NV]**, verificato con il controllo della cartella temporanea prima e dopo | — |
| 5 | Orchestratore: HMAC delle righe originali (verifica) e **sostituzione** dei valori | memoria dell'orchestratore | paging, dump come sopra | testo originale scartato riga per riga |
| 6 | Pipe → `psql` → cluster isolato (5434) | **nessun dato reale**: solo valori sostituiti | file dei dati, WAL, log del cluster isolato: solo valori sostituiti | `psql` non interattivo non scrive cronologia |
| 7 | Messaggi di errore | `pg_dump`/`pg_restore` non riportano valori; `psql` e il cluster isolato possono citare la riga che fallisce, ma ricevono solo valori sostituiti; l'orchestratore non stampa mai valori | uscite dei comandi nella trascrizione della sessione dell'assistente (`C:\Users\flavi\.claude\…`) e nei file di output dei comandi in `%TEMP%\claude\…` | solo conteggi, impronte, tempi ed esiti |
| 8 | Rapporto | nessun dato | file nella cartella di prova | solo conteggi, aggregati di HMAC con chiave distrutta, tempi |
| 9 | Log dell'app di staging, per attribuire variazioni | possibili riferimenti a identificativi | — | solo conteggi per tipo di evento, mai righe intere nella sessione |

**Rischi residui sul PC attuale (non eliminabili senza modifiche al PC)**: frammenti di dati reali dalla memoria al file di paging; dump del kernel in caso di blocco di sistema; minidump WER in caso di crash di `pg_dump`, `pg_restore` o dell'orchestratore; ibernazione se il PC va in sospensione durante la prova. Volume: pochi KB di dati di prova; durata: pochi minuti. **Condizione operativa**: PC acceso e non in sospensione durante la prova (nessuna modifica di configurazione: basta non lasciarlo inattivo).

### 10.5 Pseudonimizzazione o anonimizzazione

- **Pseudonimizzazione** (art. 4.5 GDPR): i dati non sono più attribuibili a una persona **senza informazioni aggiuntive** conservate separatamente (es. una chiave HMAC). I dati restano **dati personali**.
- **Anonimizzazione** (considerando 26 GDPR): la persona non è più identificabile con mezzi ragionevolmente utilizzabili, tenendo conto di isolamento, correlazione e deduzione. I dati anonimi escono dall'ambito del GDPR.

Valutazione onesta:

- l'opzione 2-P è **pseudonimizzazione** finché esiste la chiave; dopo la distruzione della chiave, i codici non sono più ricalcolabili, ma la struttura dei dati resta;
- l'opzione 2-R sostituisce i valori con valori casuali senza chiave; tuttavia lo staging è minuscolo (1 organizzazione, 2 persone): conteggi, ordine temporale e struttura potrebbero permettere a chi conosce lo staging di ricondurre le righe agli originali. **Non si dichiara quindi la copia «anonima»**: è un insieme **fortemente de-identificato**, da trattare comunque con le misure di §10.7 e da cancellare a fine prova.

### 10.6 Regole di sostituzione (2-R)

Principio: **elenco chiuso di ciò che resta invariato; tutto il resto viene sostituito**, comprese colonne e chiavi JSON non previste.

| Tipo di dato | Trattamento | Motivo |
| :--- | :--- | :--- |
| Identificativi UUID (chiavi primarie ed esterne) | rimappati su UUID casuali con una **mappa unica in memoria**, applicata ovunque compaiano: colonne, testo (`user_tenant.user_id`, `storage_path`, `idempotency_key`) e valori JSON (es. `practiceId` nei payload) | relazioni e vincoli restano coerenti; nessun legame con gli identificativi dello staging |
| Date e ore | traslate di uno **stesso scostamento casuale** per tutta la prova (colonne e date nei JSON) | ordine e intervalli restano validi (scadenze, scheduler); date reali non riconoscibili |
| Enumerazioni, booleani | invariati | non personali; necessari ai vincoli |
| Numeri in colonna (dimensioni, versioni, tentativi, conteggi) | invariati | non personali |
| Testo tecnico in elenco chiuso (`mime_type`, `event_type`, `module`, `integration_type`, `task_type`, `frequency`, modello e fornitore AI, `outcome`, `action`, `_prisma_migrations`) | invariato | non personale; necessario alla verifica di schema e migrazioni |
| Altro testo (`email`, `telegram_id`, `phone_number`, `name`, `code`, `webhook_url`, `title`, `notes`, `file_name`, `error`) | sostituito con valori casuali **dello stesso formato** (email `@example.invalid`, numeri casuali per telefono e ID Telegram, URL `https://example.invalid/…`, testo `anon_<casuale>` a lunghezza fissa) | rispetta formati e vincoli di unicità senza rivelare lunghezze o contenuti |
| Stesso valore in più punti (es. ID chat in `user.telegram_id` e in `outbox_message.delivered_targets`) | stessa sostituzione grazie alla mappa in memoria | coerenza tra tabelle |
| Array (`delivered_targets`) | ogni elemento trattato come testo | — |
| JSON: chiavi | mantenute solo le chiavi degli schemi applicativi noti (payload canonico delle pratiche, risultato OCR, payload degli eventi); **chiavi sconosciute rinominate** (`k_<casuale>`), perché possono essere scelte dagli utenti (es. `metadata`) | evita che dati finiscano nei nomi delle chiavi |
| JSON: valori | per chiave nota, secondo il tipo dichiarato (enumerazione invariata, data traslata, numero invariato o casuale se identificativo, stringa sostituita); per chiave sconosciuta: sostituiti | — |
| Testo libero (note, titoli, testo OCR, messaggi d'errore) | sempre sostituito | può contenere qualsiasi dato |
| Credenziali (`invite_code.code`, token in URL) | sempre sostituite | — |
| Colonna non classificata | sostituita per default e segnalata nel rapporto | nessuna fuga per omissione |

**Unicità**: la mappa è iniettiva (in caso di collisione si rigenera). **Vincoli e trigger**: identificativi rimappati in modo coerente, quindi chiavi esterne, unicità e il trigger di coerenza utente-azienda restano soddisfatti; PostgreSQL li verifica durante il ripristino (i vincoli vengono creati dopo il caricamento dei dati).

**Mappa e chiave**: la mappa di sostituzione e la chiave HMAC di verifica (§10.8) sono generate con `crypto.randomBytes` nell'orchestratore, restano solo nella sua memoria, non vengono mai scritte né stampate né passate ad altri processi (la verifica avviene nell'orchestratore, non sullo staging: `pgcrypto` non serve). A fine prova i buffer vengono azzerati e il processo termina. Limite: copie in memoria non controllabili da JavaScript e residui nel file di paging.

### 10.7 Ambiente isolato, accessi, credenziali

| Elemento | Scelta |
| :--- | :--- |
| Cartella | `C:\Users\flavi\sinfonia-restore-test`, attributo «non indicizzato», permessi solo per `flavi` e SYSTEM (interventi sulla sola cartella nuova, compresi nell'approvazione di MF0) |
| Cluster isolato | PostgreSQL 17 (`initdb`), porta 5434, solo `localhost`, `scram-sha-256`, password casuale generata dall'orchestratore |
| Cluster esistenti | staging (5433) e servizio di sistema (5432) non toccati |
| Applicazione | non avviata; lettura applicativa con uno script senza bot né processi in background |
| Staging, consentito | sessione `REPEATABLE READ READ ONLY` con istantanea esportata; `COPY … TO STDOUT` e `SELECT` di catalogo nell'istantanea; `pg_dump --snapshot`; lettura di `pg_stat_user_tables` e `pg_stat_activity` |
| Staging, vietato | scritture, DDL, ruoli, configurazioni, migrazioni, riavvii, uso del bot, lettura dei file degli allegati |
| Credenziali dello staging | quelle esistenti (privilegiate), lette senza stamparle; `application_name = 'sinfonia-mf0'` |
| Allegati | reali **esclusi**; meccanismo provato su un campione sintetico generato con gli strumenti esistenti |

### 10.8 Che cosa dimostrano le impronte

Rispetto alla versione 5 (impronte per colonna) il controllo diventa **per riga**, perché le impronte per colonna non escludono valori scambiati tra righe diverse.

| Verifica | Come | Che cosa dimostra | Che cosa **non** dimostra |
| :--- | :--- | :--- | :--- |
| **V1 Righe** | per ogni tabella, HMAC di ogni riga in formato `COPY` letta dallo staging nell'istantanea; stesso calcolo sulle righe del dump nel flusso di ripristino **prima** della sostituzione; confronto degli aggregati (elenco ordinato degli HMAC) | il dump contiene **esattamente** le stesse righe dello staging, con tutti i valori di tutte le colonne, né una in più né una in meno | che i valori originali vengano riscritti correttamente in un database (nella copia arrivano valori sostituiti) |
| V2 Conteggi | righe per tabella nella copia | nessuna riga persa nel ripristino | — |
| V3 Schema | confronto del catalogo della copia con quello dello staging: tabelle, colonne e tipi, vincoli, indici, trigger, funzioni, estensioni | lo schema viene ripristinato identico | ruoli e privilegi: **non** fanno parte di `pg_dump`; vanno salvati con `pg_dumpall --globals-only` (da aggiungere in MF1) |
| V4 Vincoli e relazioni | successo della creazione di chiavi primarie, unicità, chiavi esterne e controlli durante il ripristino; query sugli orfani | i dati ripristinati soddisfano tutti i vincoli | — |
| V5 Trigger attivi | sulla copia, un `UPDATE` su `audit_log` viene rifiutato | il trigger di immutabilità funziona dopo il ripristino | — |
| V6 Migrazioni | `_prisma_migrations` identica | lo stato delle migrazioni è ripristinato | — |
| V7 Lettura applicativa | lettura delle pratiche della copia tramite i servizi | i dati sostituiti restano leggibili dall'app | il comportamento con i valori reali |
| V8 Allegati sintetici | impronte dei file prima e dopo | il meccanismo di backup dei file funziona | completezza e ripristino dei **file reali** |
| V9 Staging invariato | contatori di scrittura e attribuzione delle variazioni (come versione 5) | nessuna scrittura della prova sullo staging | — |
| V10 Disco | manifesto degli artefatti e confronto della cartella temporanea prima e dopo | nessun file in chiaro con dati reali creato dalla prova | residui nel file di paging o nei dump di memoria |

**Ipotesi da validare prima**: le righe di `COPY … TO STDOUT` e quelle del dump coincidono solo se la sessione usa le stesse impostazioni di `pg_dump` (`DateStyle = ISO`, `extra_float_digits = 3`, codifica UTF-8, ecc.) **[NV]**. Va provato su un database di test sintetico prima di MF0.

**Restano non verificati in MF0**: ripristino diretto (`pg_restore -d`) e parallelo; valori reali riscritti in un database; ruoli e privilegi; file reali degli allegati; tempi con volumi reali; ripristino a un istante preciso (WAL). Vanno provati in MF11 su un ambiente cifrato a riposo.

### 10.9 Procedura

1. Prova preliminare su un database di test **sintetico**: coincidenza del formato delle righe (§10.8), regole di sostituzione, nessuna colonna non classificata lasciata invariata.
2. Controlli: spazio, strumenti PostgreSQL 17, porta 5434, sincronizzazione, backup del PC, cartella temporanea (elenco iniziale), PC non in sospensione.
3. Creazione della cartella con attributo e permessi.
4. T0: contatori di scrittura dello staging.
5. Sessione in sola lettura: istantanea, catalogo, HMAC delle righe.
6. `pg_dump --snapshot` cifrato a flusso.
7. Cluster isolato; ripristino a flusso con verifica e sostituzione; campione sintetico degli allegati.
8. Verifiche V1–V10.
9. T1 e attribuzione.
10. Rapporto (solo conteggi, aggregati e tempi).
11. Dopo conferma: cancellazione e verifica.

### 10.10 Cancellazione e verifica

Arresto del cluster; porta libera; cancellazione della cartella senza Cestino; nessun percorso del manifesto esistente; cartella temporanea uguale all'elenco iniziale; nessun minidump WER creato durante la prova; rapporto di cancellazione con data, ora ed esiti. Il dump cifrato resta illeggibile dopo la fine dell'orchestratore (chiave mai salvata). Su SSD i file cancellati possono restare fisicamente: con 2-R si tratta solo di dati cifrati, sostituiti o sintetici.

### 10.11 Raccomandazione

**Opzione 2-R sul PC attuale**, perché:

- nessuna modifica al PC e nessun acquisto;
- sul disco non viene scritto alcun dato reale in chiaro (solo dump cifrato, valori sostituiti, dati sintetici);
- la verifica per riga (V1) dimostra la completezza del dump senza dover riscrivere i valori reali;
- l'opzione 1a non elimina i rischi della memoria (paging, dump, ibernazione) e in più espone i dati reali in chiaro durante la prova.

Condizioni: accettazione esplicita del rischio residuo di §10.4; PC non in sospensione durante la prova; prova preliminare superata su dati sintetici. La prova completa con valori e file reali resta da fare in MF11, su un ambiente cifrato a riposo.

### 10.12 Cosa produce

Dopo approvazione: orchestratore, regole di sostituzione e verifiche in `scripts/backup/`, test automatici su un database sintetico, procedura in `docs/`. Nessuna nuova dipendenza (libreria `pg` e strumenti PostgreSQL già presenti **[V]**).

### 10.13 Richiesta di approvazione per MF0 fase 2 (staging) — non autorizzata

**Stato al 29/10/2026**: fase 1 completata su dati sintetici, tutte le verifiche superate ([PR #10](https://github.com/Sinfoni4/SinfonIA/pull/10)). La fase 2 esegue gli stessi script con lo **staging come sorgente**, in sola lettura, con la protezione 2-R. Gli script vengono eseguiti dal ramo `feat/mf0-backup-restore-test` anche se la PR non è ancora unita.

**Condizioni da verificare subito prima** (nessuna modifica al PC)

| # | Condizione | Chi la verifica |
| :-: | :--- | :--- |
| P1 | OneDrive e Dropbox non sincronizzano `C:\Users\flavi\sinfonia-restore-test` (nessuna cartella aggiuntiva configurata nei client) | il proprietario |
| P2 | Cronologia file e altri programmi di backup del PC non includono quella cartella | il proprietario |
| P3 | Il PC resta acceso e non va in sospensione o ibernazione durante la prova (circa 20 minuti) | il proprietario |
| P4 | Sullo staging `log_statement = none` e parametri non registrati in caso di errore (già verificato il 29/10/2026, da ripetere in sola lettura) | Claude |
| P5 | Facoltativo: nessuno usa il bot di staging durante la prova, per non dover attribuire variazioni | il proprietario |

**Approvazioni richieste, ciascuna separata**

| # | Approvazione | Cosa autorizza | Cosa non autorizza |
| :-: | :--- | :--- | :--- |
| A1 | **Protezione 2-R e rischi residui** | ripristino con sostituzione casuale a flusso; accettazione dei rischi residui di §10.4 (frammenti di dati reali in memoria che possono finire nel file di paging, nei dump di memoria di Windows o nell'ibernazione) | qualsiasi copia in chiaro dei dati reali su disco |
| A2 | **Cartella di prova** | creazione di `C:\Users\flavi\sinfonia-restore-test` con attributo «non indicizzato» e permessi limitati all'account `flavi` e a SYSTEM | modifiche ad altre cartelle o alle impostazioni del PC |
| A3 | **Cluster isolato** | nuovo cluster PostgreSQL 17 dentro la cartella, porta 5434, solo `localhost`, autenticazione `scram-sha-256`. La password casuale resta per la durata della prova in un file dentro la cartella protetta, perché le istruzioni sono eseguite in più passaggi; viene cancellato con la cartella | modifiche al cluster dello staging (5433) o al servizio PostgreSQL di sistema (5432) |
| A4 | **Esecuzione sullo staging** | con `MF0_PHASE=2` e `MF0_STAGING_APPROVED=yes`: sessione `REPEATABLE READ READ ONLY`, istantanea, letture di catalogo e `COPY … TO STDOUT` nell'istantanea, `pg_dump --snapshot`, lettura dei contatori di attività; credenziali esistenti, mai stampate | scritture, DDL, ruoli, configurazioni, migrazioni, riavvio dell'app, lettura dei file degli allegati reali |
| A5 | **Cancellazione della copia** | dopo il rapporto: arresto del cluster, cancellazione della cartella (dump cifrato, database con valori sostituiti, file sintetici, password temporanea), verifica e rapporto di cancellazione | — |

In caso di fallimento, con A5 non ancora concessa, la cartella resta isolata per la diagnosi.

**Cosa ricevi dopo l'esecuzione**: il rapporto (`mf0-report.json`, solo conteggi, esiti e tempi) con l'esito di V1–V10 e dell'anonimizzazione, le variazioni dello staging attribuite (V9), i tempi di backup e ripristino.

**Limiti già dichiarati**: il ripristino diretto con `pg_restore -d` e i file reali non vengono provati; ruoli e privilegi non fanno parte di `pg_dump`. Tutti da provare in MF11 su un ambiente cifrato.

**Durata stimata**: circa 1 ora, comprese le verifiche preliminari e la cancellazione.

---

## 11. Piano esecutivo MF2 — servizio di autorizzazione sul modello attuale — eseguito (PR #9, non unita)

### 11.1 Obiettivo e perimetro

Concentrare in un unico servizio tutte le decisioni di autorizzazione **sul modello dati attuale** (ruoli ADMIN, OPERATOR, MEMBER), senza modifiche allo schema, ai dati o alle dipendenze. Il comportamento resta identico, salvo le modifiche esplicite di §11.4 che richiedono una decisione. Esclusi da MF2: appartenenze multiple, revoca, deleghe, scheduler e outbox (micro-fasi successive).

### 11.2 File

**Nuovi**

| File | Contenuto |
| :--- | :--- |
| `src/core/authz/permissions.ts` | catalogo dei permessi con nome (es. `practice.read`, `practice.export`) e corrispondenza con i ruoli attuali, con perimetro (proprie/org) |
| `src/core/authz/principal.ts` | tipo `Principal` (persona, organizzazione, ruolo, canale) |
| `src/core/authz/authorization.service.ts` | `loadPrincipal` (persona esistente nell'organizzazione, **ruolo letto dal database**), `authorize(principal, permesso, oggetto?)` con decisione e perimetro, `require…` che solleva un errore 403 |
| `tests/authz.characterization.test.ts` | comportamento attuale di ogni rotta e comando per ruolo, scritto **prima** delle modifiche |
| `tests/authz.matrix.test.ts` | matrice attesa dichiarata nel test, indipendente dal catalogo |
| `tests/authz.coverage.test.ts` | elenca tutte le rotte registrate in Fastify e fallisce se una rotta non pubblica non dichiara un permesso; fallisce se compaiono controlli di ruolo (`role ===`) fuori da `src/core/authz/` |

**Modificati**

| File | Modifica |
| :--- | :--- |
| `src/interface/http/auth/auth.hook.ts` | dopo la verifica del token carica il `Principal` dal database; persona non trovata → 401 |
| `src/interface/http/auth/guards.ts` | `requireRole` sostituito da `requirePermission` |
| `src/interface/http/auth/auth.types.ts` | `AUTH_ROLES` rimosso a favore del catalogo |
| `src/interface/http/routes/practice.routes.ts`, `ai.routes.ts`, `compliance.routes.ts` | permesso dichiarato per rotta; il filtro «solo proprie» per i MEMBER deriva dalla decisione del servizio |
| `src/core/practice/practice.application.service.ts` | `executeCommand` riceve il `Principal` e verifica il permesso di ogni comando |
| `src/interface/conversation/conversation.service.ts` | costruisce il `Principal` e lo passa ai comandi |
| `src/interface/telegram/telegram.adapter.ts` | `canAdvance` sostituito dal servizio |
| `src/interface/telegram/compliance.command.ts` | filtro MEMBER sostituito dal servizio |
| `src/ai/execution/executor.service.ts` | verifica del permesso prima di eseguire un'azione proposta dall'AI |
| Test esistenti che costruiscono token o server | adattati solo dove cambia l'interfaccia, non le aspettative |

Nessuna modifica a `prisma/`, `.env*`, `package.json`, CI o staging.

### 11.3 Sequenza

1. Test di caratterizzazione del comportamento attuale (commit separato, devono passare sul codice attuale).
2. Catalogo e servizio, con test unitari.
3. Migrazione di API, chat, comandi e AI al servizio, una superficie alla volta, con la suite completa a ogni passo.
4. Test di copertura e matrice.
5. Eventuali modifiche di §11.4, solo se approvate, ciascuna in un commit separato con test aggiornati.

### 11.4 Modifiche di comportamento — D6, D6b

| # | Oggi **[V]** | In MF2 |
| :-: | :--- | :--- |
| C1 | Il ruolo viene preso dal token | **Proposta**: ruolo letto dal database a ogni richiesta (un token con ruolo superato non vale più; persona inesistente → 401). Richiede approvazione esplicita insieme a MF2 |
| C2 | Chat: ADMIN e OPERATOR vedono ed esportano solo le proprie pratiche | **Invariato.** Proposta in §3.4, da approvare separatamente; implementazione dopo l'approvazione (MF2b) |
| C3 | Chat: chiunque cancella le proprie pratiche, senza conferma; file orfani | **Invariato.** Proposta in §3.5, da approvare separatamente; implementazione in MF13 |
| C4 | OPERATOR esporta l'intera azienda via API | **Invariato.** Rinviato a MF8 (§3.3) |

### 11.5 Test di regressione e criteri di accettazione

- Suite esistente completa verde (321 test al 29/10/2026 **[V]**), typecheck, lint, formato, build; CI verde.
- **Una suite verde non basta**: MF2 aggiunge test specifici per ogni area con lacune note (§12.5): API, chat, AI, allegati; scheduler, outbox e revoche restano a MF5.
- Test di caratterizzazione in un file marcato «comportamento attuale, non normativo»: verdi prima e dopo MF2.
- Matrice attesa: verificata per le parti decise; i casi di C2 e C3 restano `it.todo` fino alla decisione.
- Richieste verso oggetti di un'altra organizzazione: 404 o 403 su ogni rotta e comando.
- Copertura: nessuna rotta non pubblica senza permesso; nessun controllo di ruolo fuori da `src/core/authz/`.
- AI: un'azione proposta non consentita al richiedente viene bloccata e registrata.
- Nessuna differenza in `prisma/`, `package.json`, configurazioni.
- Prestazioni, **criterio rivisto (29/10/2026)**: il limite relativo «p95 al massimo +20%» non è adatto a richieste di 4–6 ms, perché su questo PC il rumore tra misure supera il 20%. Criterio assoluto, misurato con giri alternati `main`/ramo e mediana di 3 giri sul database di test: **fino a 5 richieste simultanee, al massimo +5 ms al p50 e +10 ms al p95** per elenco e dettaglio delle pratiche. Esito finale sul ramo (3 giri alternati con `main`, mediane, costo aggiunto p50/p95): con la ricerca del ruolo per chiave primaria tramite query preparata sul pool `pg` (`b17b82f`) e l'elenco paginato in una sola query (`db544f7`) il criterio è **rispettato**: elenco +0,1/−0,3 ms a 1 richiesta e −3,4/−3,3 ms a 5 (più veloce di `main`, perché usa una connessione invece di due); dettaglio +1,1/+1,1 ms a 1 richiesta e +1,9/+3,7 ms a 5. Provata e scartata l'attesa differita del ruolo (`9ad5073`, annullata da `f01b053`): nessun miglioramento coerente. Da rimisurare sull'ambiente reale del pilota; il pool di connessioni resta una decisione di configurazione separata.

### 11.6 Rollback

Tutto su un ramo dedicato e una sola PR. Nessuna modifica a schema, dati o configurazioni: il rollback è il `git revert` del commit di unione e il riavvio dell'app. Nessun interruttore di funzionalità, per non mantenere due percorsi di autorizzazione paralleli.

---

## 12. Test: stato effettivo

### 12.1 Presenti ed eseguiti

Eseguiti nella suite completa del 29/10/2026 (321/321 in locale; CI verde su `main` al commit `803162b`) **[V]**:

| Area | Test |
| :--- | :--- |
| Isolamento repository | `tests/data.test.ts` («creates tenant, user, practice and enforces tenant isolation»); `tests/workflow.test.ts` («enforces tenant isolation via repository scoping») |
| API, ruoli e token | `tests/auth.test.ts` («rejects expired tokens», «enforces roles and authoritative token tenant»); `tests/practice.api.test.ts` |
| AI | `tests/ai.phase3a.test.ts` (isolamento del contesto, tracce per tenant); `tests/ai.traces.test.ts`; `tests/ai.evaluation.test.ts`; test di sicurezza dei prompt in `tests/security.step1.test.ts` e `tests/ai.security.test.ts` |
| Scadenze | `tests/compliance.test.ts` («forbids members from creating or closing deadlines», «does not let a tenant close another tenant deadline») |
| Allegati e storage | `tests/storage.test.ts` (prefisso, lettura e cancellazione nel solo prefisso, cartella con prefisso simile); `tests/ocr.document.test.ts` (cartella isolata, path traversal, allegato su pratica di un altro utente) |
| Scheduler | `tests/scheduler.test.ts` (export di tutti gli utenti dell'azienda) |
| Outbox | `tests/outbox.dispatcher.test.ts` (consegna, ripetizioni, lease) |
| Chat | `tests/whatsapp.adapter.test.ts` (collegamento con invito, firma del webhook); test di parità Telegram/WhatsApp |
| Limiti | `tests/security.step1.test.ts` (per utente, per tenant) |

Fuori dalla suite: verifica di isolamento sotto carico del 29/10/2026 (500/500 respinte), script non versionato; valutazione AI con modello reale del 29/10/2026 (61/61).

### 12.2 Implementati ma non eseguiti in questa fase

Harness eseguibili a mano, fuori da `npm test`, non eseguiti dopo le ultime modifiche **[V]**: `tests/ai.behavior.harness.ts` (`npm run ai:test`, usa OpenAI), `tests/core/ai.core.harness.ts`, `tests/domain/artist-practice.harness.ts`, `tests/test.all.ts`; script `scripts/ocr-accuracy.ts`.

### 12.3 Progettati, non implementati

| # | Test | Micro-fase |
| :-: | :--- | :-: |
| 1 | Accesso incrociato negato per ogni endpoint e comando, matrice attesa indipendente | MF2 |
| 2 | Persona in più aziende con ruoli diversi; scelta dell'azienda in chat | MF4 |
| 3 | Invito scaduto, usato, revocato, accettato con email diversa | MF6 |
| 4 | Persona disattivata o revocata con token valido (API e chat) | MF5 |
| 5 | Delega scaduta o revocata; beneficiario non approvato; nuovo membro dell'organizzazione beneficiaria senza accesso | MF8 |
| 6 | Consulente su documento fuori delega | MF8 |
| 7 | Consulente: modifica, approvazione, esportazione non autorizzate | MF8 |
| 8 | Admin di rete senza delega; soglia sugli aggregati | MF9 |
| 9 | File di un'altra organizzazione: download, storage locale e S3 | MF2, MF5 |
| 10 | Codice di collegamento scaduto, riusato, da altro ID, tentativi esauriti, collegamento concorrente; gruppi ignorati | MF7 |
| 11 | Revoca del collegamento Telegram | MF7 |
| 12 | Scheduler, outbox ed export non raggiungono persone revocate né organizzazioni disattivate | MF5 |
| 13 | Ruolo applicativo PostgreSQL senza DDL, senza UPDATE/DELETE su audit, senza `BYPASSRLS` | MF1 |
| 14 | RLS | non applicabile (esclusa) |
| 15 | Migrazione su copia, integrità, rollback eseguito | MF3, MF4 |
| 16 | Ripristino effettivo da backup | MF0 |
| 17 | Login: tentativi esauriti, riuso del rinnovo, risposte uguali per email esistenti e non | MF6 |
| 18 | Recupero account: email segnaposto da altro ID rifiutata; nessuna fusione automatica | MF6, MF7 |
| 19 | Azione proposta dall'AI non consentita bloccata | MF2 |
| 20 | Audit di ogni esportazione e variazione di permessi | MF2, MF5 |
| 21 | Caratterizzazione del comportamento attuale di chat e API per ruolo (non normativa) | MF2 |
| 22 | Ciclo di cancellazione: conferma, blocchi per stato, file rimossi, audit, registro | MF13 |
| 23 | Vista predefinita della chat e richiesta esplicita (dopo la decisione C2) | MF2b |

### 12.4 Bloccati da dipendenze esterne

- Invio reale delle email: fornitore non scelto (nei test: mittente simulato).
- Prova WhatsApp end-to-end: app Meta da creare.
- Prova di ripristino sull'ambiente reale del pilota: ambiente non ancora esistente.

### 12.5 Lacune per area (perché una suite verde non basta)

| Area | Coperto oggi | Manca |
| :--- | :--- | :--- |
| API | ruoli per alcune rotte, isolamento a campione | matrice sistematica su tutte le rotte (#1) |
| Chat | collegamento WhatsApp, parità tra canali | ruoli dei comandi testuali (elenco, cancellazione, export), gruppi, conferme (#10, #21, #22) |
| AI | sicurezza dei prompt, isolamento del contesto | azione proposta non consentita (#19) |
| Scheduler | export dell'intera azienda | destinatari revocati, organizzazioni disattivate (#12) |
| Outbox | affidabilità della consegna | autorizzazione dei destinatari all'invio (#12) |
| Allegati | prefisso dello storage, path traversal | download (assente), file orfani alla cancellazione (#9, #22) |
| Revoche | nulla (funzione assente) | #4, #11, #12 |

---

## 13. Servizi email: confronto aggiornabile — D11

Verificato il 29/10/2026. Da ripetere prima della scelta: i prezzi cambiano.

| | SMTP esistente (Aruba, casella del dominio) | Brevo | Mailjet | Amazon SES |
| :--- | :--- | :--- | :--- | :--- |
| Costo iniziale | 0 € | 0 € | 0 € | 0 € (credito Free Tier per nuovi clienti AWS) |
| Costo ricorrente | incluso nella casella | piano gratuito; a pagamento **[NV]** | gratuito; Starter 9 $/mese per 8.000 email senza limite giornaliero **[V]** | 0,10 $ ogni 1.000 email + 0,12 $/GB di allegati **[V]**; nuovi piani Essentials 0,16 $, Pro 0,22 $ (+105 $/mese) per 1.000 **[V]** |
| Limiti | max 150 destinatari per invio; consigliate ≤ 250 email ogni 20 minuti; oltre si ottiene «policy violation» temporaneo **[V]** | 300 email al giorno sul piano gratuito **[NV]**: fonti non ufficiali, la pagina ufficiale non è leggibile dallo strumento | 200 al giorno, 6.000 al mese; API, relay SMTP e webhook inclusi; logo Mailjet nel piano gratuito **[V]** | sandbox iniziale: solo destinatari verificati, 200 messaggi/24 h, 1/s; uscita su richiesta con risposta entro 96 ore **[V]** |
| Uso transazionale | casella pensata per posta personale | sì | sì | sì |
| Deliverability | dipende da SPF/DKIM del dominio e reputazione dell'IP condiviso | buona (fornitore specializzato) **[NV]** | buona (fornitore specializzato) **[NV]** | molto buona con dominio verificato **[NV]** |
| DPA e trattamento | condizioni Aruba (Italia) **[NV]** | DPA disponibile, società francese **[NV]** | DPA ora pubblicato da Sinch (rinvio verificato dal sito Mailjet) **[V]**; contenuti e luoghi di trattamento **[NV]** | DPA AWS con clausole GDPR **[NV]**; regione UE selezionabile |
| Configurazione | bassa: credenziali SMTP, SPF, DKIM | media: account, verifica dominio | media: account, verifica dominio | alta: account AWS, IAM, verifica dominio, uscita dalla sandbox |
| Dipendenze esterne | fornitore di posta esistente | Brevo | Mailjet/Sinch | AWS |
| Manutenzione | bassa, diagnosi difficile in caso di blocco | bassa | bassa | media (rimbalzi, reclami, IAM) |

Volumi del pilota stimati: poche decine di email al giorno (login, inviti, avvisi di sicurezza).

Indicazioni progettuali confermate: interfaccia `EmailSender` indipendente dal fornitore, implementazione SMTP (con libreria da installare **solo dopo approvazione**) compatibile con tutti e quattro; mittente simulato in sviluppo e CI. **Nessun fornitore scelto né attivato.**

Fonti ufficiali: [Mailjet, prezzi](https://www.mailjet.com/pricing/); [Amazon SES, prezzi](https://aws.amazon.com/ses/pricing/); [Amazon SES, sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html); [Aruba, caratteristiche caselle](https://guide.aruba.it/hosting-e-domini/email/gestione-email/caratteristiche-acquisto-gestione/caratteristiche-caselle-posta-dominio); [Aruba, errori di invio](https://guide.aruba.it/faq/email/errori-comuni-invio-e-ricezione-email); [Aruba, policy d'uso](https://hosting.aruba.it/doc/jcr:94bf94ad-4cab-4386-a4de-988c05155eba/lang:it/policy-utilizzo-servizi-aruba.pdf). Brevo, fonte non ufficiale: [guida ai piani 2026](https://dev.to/techsifted/brevo-pricing-2026-every-plan-explained-with-the-hidden-costs-4oe3).

---

## 14. Approvazioni necessarie per attività

| Attività | Approvazioni distinte richieste |
| :--- | :--- |
| MF0 | (1) scelta della protezione (2-R raccomandata) e accettazione dei rischi residui; (2) scrittura degli script e prova preliminare su dati **sintetici**; (3) creazione della cartella di prova con attributo e permessi; (4) esecuzione sullo staging in sola lettura; (5) cancellazione della copia. **Separata da MF2** |
| MF1 | (1) piano e script dei ruoli; (2) applicazione allo staging |
| MF2 | (1) esecuzione su un ramo; (2) decisione C1; (3) unione della PR. **Separata da MF0** |
| MF2b (vista chat, C2) | (1) regola finale C2; (2) esecuzione; (3) unione |
| MF13 (cancellazione, C3) | (1) regola finale C3; (2) migrazione su copia; (3) eventuale cancellazione dei file orfani esistenti; (4) unione |
| Migrazioni (MF3, MF4, MF10, MF12, MF13) | (1) esecuzione su copia isolata; (2) applicazione allo staging |
| MF6 | (1) scelta del fornitore email; (2) installazione della libreria SMTP; (3) creazione dell'account del fornitore da parte del proprietario |
| MF8 (export OPERATOR, deleghe) | regola finale D5 |
| MF10 | durate di conservazione dopo verifica legale (D10) |
| MF11 | applicazione allo staging |
| Ogni PR | unione in `main` |
| Accesso eccezionale | implementazione in una fase futura |

---

## 15. Stime per micro-fase

| MF | Contenuto | Giorni | Dipende da | Completata quando | Incertezze principali |
| :-: | :--- | :-: | :--- | :--- | :--- |
| MF0 | Backup e prova di ripristino con sostituzione a flusso e verifica per riga | 3,5–4 | D14 | V1–V10 di §10.8 e cancellazione verificata | coincidenza del formato delle righe (§10.8); chiavi JSON degli schemi; strumenti di backup del PC |
| MF1 | Ruoli PostgreSQL | 1,5 | MF0 | test #13 verde in CI e su copia | privilegi richiesti da Prisma per le migrazioni |
| MF2 | Servizio di autorizzazione (comportamento invariato salvo C1) | 5–6 | — | criteri §11.5 | quantità di test da adattare; casi della chat da caratterizzare |
| MF2b | Vista predefinita della chat (C2) | 1–1,5 | MF2, D6 | test #23 verde | regola finale |
| MF3 | Schema M1 su copia | 3 | MF0, MF2 | integrità e rollback provati su copia | conversione di `user_tenant.user_id` |
| MF4 | M2, appartenenze, trigger, scelta azienda | 3–4 | MF3 | test #2 e #15 verdi | rollback con persone in più aziende |
| MF5 | Revoca, scheduler, outbox, download | 2–3 | MF4 | test #4, #9, #12 verdi | prestazioni della verifica per richiesta |
| MF6 | Login email, sessioni, inviti, recupero | 4 | MF5, D11 | test #3, #17, #18 verdi | consegna delle email |
| MF7 | Collegamento Telegram/WhatsApp, chat private | 3 | MF6 | test #10, #11 verdi | account esistenti con email segnaposto |
| MF8 | Deleghe, beneficiari, consulente, export OPERATOR | 3–4 | MF5, D3, D5 | test #5, #6, #7 verdi | complessità degli ambiti |
| MF9 | Reti, adesioni, aggregati | 3 | MF8, D4 | test #8 verde | indicatori |
| MF10 | Conservazione, export e cancellazione dell'organizzazione, audit | 3 | MF4, D10 | procedure provate su copia | esiti della verifica legale |
| MF13 | Ciclo di cancellazione delle pratiche, file orfani | 3–4 | MF5, D6b | test #22 verde, riconciliazione dei file eseguita su copia | regole sui documenti soggetti a conservazione |
| MF11 | Applicazione allo staging e prova di ripristino completa | 1,5 | MF0–MF8, MF10, MF13 | integrità verificata | — |
| MF12 | Pulizia M3 | 1 | MF11 + periodo di verifica | colonne rimosse, test verdi | — |
| | **Totale** | **40,5–47,5** (circa 8–9,5 settimane) | | | |

Rispetto alla versione 3 (34,5–38,5 giorni): +1–1,5 MF0 (anonimizzatore a flusso, impronte, campione sintetico), +1–1,5 MF2b, +3–4 MF13, +0,5 MF11. Con l'opzione del disco esterno cifrato MF0 scende a circa 2 giorni, più i tempi di acquisto.

Il primo pilota richiede MF0–MF8, MF10, MF11 e MF13; MF2b e MF9 possono seguire.

**Incertezze principali**: decisioni C2, C3, D5 e D10 (cambiano il perimetro di MF2b, MF8, MF10, MF13); esiti della verifica legale; scelta e configurazione del fornitore email; stato della cifratura del disco per MF0; regressioni della chat in MF2.

---

## 16. Stato e autorizzazioni

**Al 29/10/2026**:

- **MF2 eseguito** su `feat/mf2-authorization` con C1 e le ottimizzazioni misurate (§11.5): [PR #9](https://github.com/Sinfoni4/SinfonIA/pull/9), CI verde, **non unita**.
- **MF0 fase 1 eseguita su dati sintetici** in un cluster isolato poi cancellato: tutte le verifiche superate, [PR #10](https://github.com/Sinfoni4/SinfonIA/pull/10), **non unita**. Nessun dump, copia, database o rapporto con dati reali è stato creato.
- **MF0 fase 2 non eseguita**: approvazioni richieste in §10.13.
- Nessuna modifica a schema, dati, configurazioni, dipendenze, staging, PC o servizi esterni. Sul database di test (dati sintetici) sono state aggiunte righe per le misure di prestazioni.
- Ogni attività futura richiede una **propria approvazione esplicita** (§14); MF0 e MF2 sono autorizzati separatamente.

**Operazioni eseguite per preparare il piano (tutte in sola lettura)**: lettura del codice e degli schemi; conteggi, catalogo delle colonne, estensioni e impostazioni dei log sullo staging in transazioni di sola lettura; letture delle impostazioni del PC (sincronizzazione, indicizzazione, file di paging, dump di memoria, unità); consultazione di fonti web per i servizi email. Le attività operative precedenti di questa sessione (unione delle PR #6–#8, migrazioni e riavvio dello staging, test di carico sul database di test) sono anteriori alla Fase 1 e furono approvate allora.

| Affermazione | Stato |
| :--- | :--- |
| Modello attuale utente-azienda, punti del codice dipendenti, incoerenze tra canali, cancellazione con file orfani, eventi di audit presenti | **verificato** nel codice (§0) |
| Ruolo PostgreSQL privilegiato, impostazioni dei log, colonne di testo e JSON, `pgcrypto` installato | **verificato** sullo staging in sola lettura |
| File di paging non cifrato, dump di memoria automatici, cartella fuori da OneDrive e Dropbox, Windows Search attivo | **verificato** sul PC in sola lettura |
| BitLocker non attivo | **dichiarato** dal proprietario |
| Configurazione dei client di sincronizzazione, strumenti di backup del PC, ibernazione, invio dei rapporti WER | **non verificato** |
| `pg_restore` da pipe senza file temporanei; coincidenza del formato delle righe tra `COPY` e dump | **presunto**, da provare su dati sintetici |
| Prezzi e condizioni dei servizi email | **verificato** su fonti ufficiali dove indicato (§13), altrimenti non verificato |
| Obblighi di conservazione, ruoli GDPR, regole di cancellazione | **da verificare** con consulenza legale e privacy |
| Tutto il resto del documento (modello, flussi, regole, micro-fasi, stime) | **progettato**, non implementato |
