# SinfonIA — Fase 1: Core e modularità (A01–A06, A11, A12)

**Data**: 05/11/2026 · **Ramo**: `feat/phase1-modules` · **Stato**: implementato e provato sul database dei test; la migrazione `20261106090000_a03_tenant_features` **non** è applicata allo staging (serve approvazione).

Versione ridotta concordata di A04/A05: gli **stati comuni** delle pratiche restano quelli del Core (CREATED, VALIDATED, SUBMITTED, COMPLETED, FAILED); il modulo di settore aggiunge tipi di pratica, campi validati, sotto-stati, categorie di scadenza, documenti attesi e istruzioni per l'IA. Gli step A07–A10 (Odoo) partono solo dopo la conferma di TerreFVG (domanda A7 del questionario) e un'istanza di prova.

---

## 1. A01 — Inventario delle dipendenze di settore nel Core

| Dove | Che cosa c'era | Ora |
| :--- | :--- | :--- |
| `src/core/practice/practice.payload.ts` | Tipi `artist`, `music`, `generic` scritti a mano, etichette e riepiloghi «pratica artista», «pratica music» | Tipi, etichette e riepiloghi letti dai moduli; restano solo i nomi dei tipi salvati nei dati (`*_practice`) e la lettura di `artistName` delle pratiche vecchie |
| `src/core/practice/practice.application.service.ts` | La chat creava sempre pratiche `music`; l'API usava `generic` | Tipo predefinito del modulo dell'organizzazione; tipo di un altro modulo rifiutato |
| `src/interface/conversation/conversation.service.ts` | Benvenuto «🎵 … alla tua cooperativa» per tutti | Benvenuto del modulo |
| `src/core/compliance/compliance.service.ts` | Categorie agricole (bio, patentino) valide per tutte le organizzazioni | Solo le categorie del modulo (ALTRO sempre) |
| `src/ai/interpreter/interpreter.prompt.ts` | Nessun contesto di settore | Istruzioni del modulo nel prompt, dichiarate come testo di SinfonIA e non dell'utente |
| `web/src/pages/NewPracticePage.tsx` | Elenco fisso Generica / Musicale / Artista | Tipi e campi dal modulo (`GET /modules/current`) |

**Restano (debito noto, controllato da `tests/a01.core-modules.test.ts`, che impedisce di aggiungerne altri)**:

- `artistName` nel contratto JSON dell'IA (interprete, normalizzatore, stub, banco di valutazione): da rinominare in `name` insieme al banco di valutazione dell'IA, per non perdere la confrontabilità delle misure (fase 3, Q-step).

**Risolti dopo la prima consegna** (ramo `feat/phase1-defaults-demo`):

- Modulo predefinito: un'organizzazione creata senza indicare il settore ha ora il modulo «Generico» (database, repository, `tenant.provisioning.ts`, script `tenant:provision`); migrazione `20261106100000_a01_default_module_generic`, che cambia solo il valore predefinito, con ritorno in `prisma/rollback/`. Le organizzazioni già presenti non cambiano; i test e i seed musicali indicano ora il settore.
- Messaggi della chat neutri: 📋 al posto di 🎵 nei messaggi delle pratiche, «organizzazione» al posto di «cooperativa», esempio di scadenza «DURC annuale».

## 2. A02 — Contratto tra Core e moduli

- Contratto: `src/core/modules/module.contract.ts` (`VerticalModule`, `PracticeTypeDefinition`, `FieldDefinition`, `SubStateDefinition`, `ExpectedDocument`).
- Moduli: `src/modules/generic.module.ts`, `music.module.ts`, `agri.module.ts`; registro `src/modules/registry.ts`.
- Un modulo è **dati**, non codice: non aggiunge stati, permessi o rotte e importa solo il contratto (verificato dai test).
- Il modulo dell'organizzazione è `tenant.module`; un valore sconosciuto vale «Generico».

| Modulo | Tipi di pratica | Categorie di scadenza |
| :--- | :--- | :--- |
| Generico | Generica | tutte |
| Musica e spettacolo | Generica, Musicale, Artista | DURC, Sicurezza sul lavoro, Visita medica, Altro |
| Agricoltura | Generica, Agricola | tutte |

## 3. A04/A05 — Tipi, campi, sotto-stati, documenti attesi

- **Campi**: `POST /practices` accetta `fields`, controllati sulla definizione del tipo (testo con lunghezza, numero con limiti, data `AAAA-MM-GG`, scelta tra valori); campi non dichiarati rifiutati; salvati in `payload.fields`. I `metadata` liberi non possono più sovrascrivere tipo, nome o campi.
- **Sotto-stati**: `POST /practices/:id/sub-state` (stesso permesso dei cambi di stato), solo tra quelli del tipo e negli stati comuni previsti; registrato nell'audit (`PRACTICE_SUB_STATE_CHANGED`); un cambio di stato comune lo chiude.
- **Documenti attesi**: elenco di promemoria nella scheda della pratica; non bloccano i cambi di stato.
- **Agricoltura**: procedimento (PAC, sviluppo rurale, certificazione bio, altro), anno della campagna, termine; fasi «Raccolta documenti», «In istruttoria», «Integrazione richiesta»; documenti: fascicolo aziendale, documento d'identità, visura, certificato bio.

## 4. A03 — Funzioni per organizzazione (voce 16, B15)

- Catalogo: `src/core/features/features.ts` — Assistente IA, Documenti, Scadenze, Assistenza, Esportazioni, Deleghe, Statistiche di rete. Pratiche, persone, registro e impostazioni sono il Core e restano sempre attivi.
- Salvate come elenco delle funzioni **spente** (`tenant.disabled_features`): le organizzazioni esistenti non cambiano.
- **Controllo nel backend**: `authorize()` rifiuta i permessi di una funzione spenta per ogni ruolo e canale (403 `FEATURE_DISABLED`); in chat un messaggio dedicato; l'IA spenta fa rispondere con l'elenco dei comandi; i compiti pianificati della funzione non partono; una delega concessa da un'organizzazione che ha spento le deleghe non dà accesso.
- **Console**: scheda «Settore e funzioni» nella pagina dell'organizzazione (`PATCH /platform/organizations/:id/modules`), registrata nel registro della piattaforma e in quello dell'organizzazione; settore scelto anche alla creazione.
- Il dashboard nasconde le voci spente (`/auth/me` → `current.disabledFeatures`), ma la protezione è il backend.
- Spegnere una funzione non cancella dati: tornano visibili quando la si riaccende.

## 5. A06 — Contratto dei connettori ERP/CRM (solo progetto)

`src/core/integrations/connector.contract.ts`: capacità dichiarate (aziende, contatti, pratiche in lettura; stato delle pratiche in scrittura), impostazioni per organizzazione senza segreti (riferimento al gestore dei segreti), record esterni con `externalRef` e versione (idempotenza), cursori per le sincronizzazioni, controllo di salute.

Regole: un'organizzazione alla volta e solo se attivato dalla piattaforma; ciò che entra passa dai controlli del modulo come ogni altro input; ogni scambio nel registro dell'organizzazione; un errore non blocca SinfonIA (ritentato dall'outbox). Nessun connettore è implementato: Odoo (A07–A10) dopo la conferma di TerreFVG.

## 6. A11 — Verifica di B5 con scenari realistici

`tests/a11.pilot-scenario.test.ts` ricostruisce il pilota: rete agricola con 5 aziende che confermano l'adesione; pratica PAC con campi del modulo; la rete non vede i dati delle aziende; un consulente di uno studio esterno legge la pratica solo tramite delega; deleghe spente da una parte o dall'altra e statistiche di rete spente e riaccese; tracce nei registri. Si aggiunge alle prove di B5 già presenti (`mf8.delegations`, `mf8a.export-rules`, `mf9.network`).

**Dati dimostrativi del pilota** (`scripts/demo/pilot-seed.ts`, caricati da `npm run web:demo` sul database dei test, mai sullo staging): «Rete Agricola Demo» con quattro aziende che hanno aderito e una con l'invito in attesa; l'«Azienda Agricola Colle Verde» con quattro pratiche agricole (una per fase: raccolta documenti, in istruttoria, integrazione richiesta, completata), un fascicolo aziendale dimostrativo e quattro scadenze; lo «Studio Agronomico Demo» con una delega di lettura e modifica. Nomi e documenti inventati. Accessi: `rete.demo@sinfonia.test`, `colleverde.demo@sinfonia.test`, `consulente.demo@sinfonia.test` (codice mostrato sullo schermo). Provati da `tests/demo.pilot-seed.test.ts`.

## 7. A12 — Piano MF12 (solo pianificazione)

Colonne del modello precedente su `user`: `tenant_id`, `role`, `telegram_id` (vincolo unico `tenant_id, telegram_id`). Le autorizzazioni usano già `membership`; restano usi in `user.repository.ts` (13 riferimenti a `telegramId`), `tenant.store.ts`, `tenant.provisioning.ts`, `telegram.bot.ts` e nelle creazioni di utenti dei test e dei seed.

1. **Inventario automatico** degli usi (test che fallisce se ne compaiono di nuovi).
2. **Chat**: leggere il collegamento Telegram solo da `channel_identity` (come WhatsApp); copiare i collegamenti rimasti su `user.telegram_id`.
3. **Creazione utenti**: `createUser` scrive la membership e non più `tenant_id`/`role` come fonte; i test e i seed passano dal nuovo percorso.
4. **Periodo di verifica** sullo staging con le colonne ancora presenti e un controllo che confronta i due modelli.
5. **Migrazione di contrazione** (con backup e script di ritorno): rimozione del vincolo, delle colonne e dei trigger che le usano. Da approvare a parte, prima per lo staging e poi per la produzione.

## 8. Da decidere / approvare

- Applicare allo staging la migrazione `20261106090000_a03_tenant_features` (solo aggiunta di colonna con valore vuoto; ritorno in `prisma/rollback/`).
- Settore delle organizzazioni già presenti sullo staging (oggi «Musica e spettacolo» per tutte): quali passano ad «Agricoltura» o «Generico».
- Applicare allo staging anche `20261106100000_a01_default_module_generic` (solo valore predefinito, vedi §1).
