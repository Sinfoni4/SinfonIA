# SinfonIA — Architettura a tre livelli: valutazione e piano

**Stato**: decisioni H1–H10 approvate il 31/10/2026 (H1 modificata: pilota TerreFVG, §4.6) · **Data**: 31/10/2026 · **Versione**: 2
**Riferimenti**: `docs/PROGETTO_FRONTEND_V2.md` (console, sezioni per tipo, decisioni G1–G9), `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (permessi, deleghe, reti, conservazione), `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, `docs/CRONOPROGRAMMA_EVOLUTIVO.md` (Fase 5)

Questo documento confronta l'architettura a tre livelli proposta per SinfonIA con quanto esiste oggi, indica cosa manca, quali vincoli esterni vanno risolti e in che ordine procedere. Le scelte **H1–H10** (§7) sono state approvate dal proprietario il 31/10/2026; per H1 il proprietario ha scelto come pilota una **rete d'imprese agricole**, le aziende di **TerreFVG** (www.terrefvg.it), invece della cooperativa musicale proposta. Migrazioni, nuove dipendenze, fornitori e modifiche allo staging richiedono comunque un'approvazione separata al momento dell'esecuzione.

---

## 1. I tre livelli

| Livello               | Chi lo usa                                                              | Scopo                                                                                                      |
| :-------------------- | :---------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **1. Piattaforma**    | gestori di SinfonIA                                                     | salute del sistema, consumi e fatturazione verso le organizzazioni, sicurezza globale, moduli e modelli IA |
| **2. Organizzazione** | amministratori e operatori di associazioni, cooperative, consorzi, reti | back-office: pratiche, validazione dei dati, scadenze, comunicazioni, integrazioni, moduli del settore     |
| **3. Associato**      | soci e lavoratori                                                       | chat (Telegram, poi WhatsApp) e una web app leggera: documenti, vocali, scadenze, stato delle pratiche     |

Il flusso: l'associato invia (L3), l'organizzazione valida e lavora (L2), la piattaforma governa risorse, costi e sicurezza (L1).

### 1.1 Principi che restano validi

1. **Un solo database, separazione nel codice.** Tutte le organizzazioni stanno nello stesso database e ogni dato porta l'organizzazione a cui appartiene; la separazione è garantita dal servizio di autorizzazione a ogni richiesta (piano fase 1, §6: RLS esclusa). Un database per organizzazione **non** è previsto: costerebbe molto di più in gestione, backup e migrazioni, senza vantaggi a questa scala.
2. **La piattaforma gestisce, non legge** (G3). Monitoraggio, consumi e fatturazione si basano su conteggi e metadati, mai sul contenuto di pratiche, documenti o messaggi.
3. **Il frontend non è un confine di sicurezza.** Ogni permesso è deciso dal backend.
4. **Nessun dato personale in più senza base giuridica.** Ogni funzione che conserva o analizza dati nuovi (storico dei messaggi, profilazione, documenti d'identità) passa prima dalla consulenza legale.

---

## 2. Situazione al 31/10/2026

Legenda: **✅** fatto · **🟡** in parte o già pianificato · **🔴** nuovo · **⛔** bloccato da una decisione o da un elemento esterno.

### 2.1 Livello 1 — Piattaforma

| Funzione                                                                          | Stato | Note                                                             |
| :-------------------------------------------------------------------------------- | :---: | :--------------------------------------------------------------- |
| Console: organizzazioni, creazione con invito, sospensione, registro immutabile   |  ✅   | FE7 (PR #37)                                                     |
| Nomina dei gestori solo da script                                                 |  ✅   | `npm run platform:admin` (G4)                                    |
| Salute del sistema: scheduler, code, archiviazione, file orfani, ultimo backup    |  🟡   | FE8                                                              |
| Consumi IA per organizzazione: chiamate, token, latenza, esiti                    |  🟡   | FE8; i dati sono già registrati (tracce IA, senza testo)         |
| Carico dei server, uptime, stato delle integrazioni esterne (SLA)                 |  🔴   | Fase 5 (OpenTelemetry); richiede l'hosting di produzione (F4)    |
| Misurazione dei consumi per la fatturazione (membri attivi, crediti IA, messaggi) |  🔴   | Base di abbonamenti e costi (§4.1)                               |
| Abbonamenti e fatture alle organizzazioni                                         | 🔴⛔  | Fornitore di fatturazione elettronica (H3)                       |
| Registro di sicurezza globale e anomalie                                          |  🟡   | Accessi e azioni registrati; manca il rilevamento delle anomalie |
| Conservazione dei dati e cancellazioni GDPR                                       |  ⛔   | MF10, consulenza legale                                          |
| Backup cifrato e prova di ripristino                                              |  🟡   | Manuale ✅; giornaliero automatico (punto 6) da fare             |
| Moduli verticali e modelli/prompt IA per settore                                  |  🔴   | Dopo almeno due verticali reali (§4.4)                           |

### 2.2 Livello 2 — Organizzazione

| Funzione                                                                  | Stato | Note                                                                                              |
| :------------------------------------------------------------------------ | :---: | :------------------------------------------------------------------------------------------------ |
| Pratiche, allegati, dati letti, passaggi di stato                         |  ✅   | FE2                                                                                               |
| Scadenze e promemoria; export CSV                                         |  ✅   | FE3                                                                                               |
| Persone, inviti, ruoli, revoca, permessi di export                        |  ✅   | FE4                                                                                               |
| Home con indicatori, impostazioni, registro attività, uso dell'assistente |  ✅   | FE6                                                                                               |
| **Validazione dei dati letti** (conferma e correzione dei campi estratti) |  🟡   | Oggi i documenti «da verificare» sono segnalati, ma i campi non si correggono né si confermano    |
| Vista a colonne (Kanban) delle pratiche                                   |  🔴   | La macchina a stati esiste già                                                                    |
| Assegnazione delle pratiche agli operatori                                |  🔴   | Nuovo campo «assegnatario» e regola di permesso                                                   |
| Scheda completa del socio                                                 |  🟡   | Membri e pratiche esistono; manca la vista unica                                                  |
| Storico delle conversazioni in chat                                       |  ⛔   | Oggi i testi **non** vengono salvati, per scelta (H5)                                             |
| Etichette automatiche in base al comportamento dei soci                   |  ⛔   | È profilazione (GDPR): consulenza legale                                                          |
| Comunicazioni massive e segmentate                                        | 🔴⛔  | Vincoli dei canali (§3.2)                                                                         |
| Chat dal vivo operatore–socio                                             | 🔴⛔  | Richiede di salvare i messaggi (H5)                                                               |
| Connettori con gestionali e CRM                                           |  🟡   | Webhook in uscita firmati ✅; la sincronizzazione nei due sensi è un progetto per gestionale (H8) |
| Export Excel, JSON, PDF                                                   |  🟡   | CSV ✅                                                                                            |
| Moduli verticali di settore                                               |  🟡   | Campo «modulo» e tipo di pratica musicale esistenti; contenuti da costruire (H1)                  |
| Pannello dei costi verso la piattaforma                                   |  🔴   | Dopo la misurazione dei consumi                                                                   |
| Ruoli personalizzati (es. «Direttore»)                                    |  🟡   | Tre ruoli fissi più permessi concedibili; il catalogo è fatto per crescere (H6)                   |

### 2.3 Livello 3 — Associato

| Funzione                                                                                                                | Stato | Note                                                                                                           |
| :---------------------------------------------------------------------------------------------------------------------- | :---: | :------------------------------------------------------------------------------------------------------------- |
| Telegram: testo, foto e documenti con lettura automatica, scadenze, tolleranza ai refusi, risposte alle domande del bot |  ✅   |                                                                                                                |
| WhatsApp                                                                                                                | 🟡⛔  | Codice presente e spento; configurazione su Meta (H4)                                                          |
| Messaggi vocali (trascrizione)                                                                                          |  ⛔   | Chiave Mistral                                                                                                 |
| Pulsanti rapidi (`Conferma`, `Modifica`, `Stato pratica`, `Le mie scadenze`, `Parla con un operatore`)                  |  🔴   | Realizzabile subito su Telegram                                                                                |
| Riconoscimento senza attrito (codice monouso, numero di telefono)                                                       |  ⛔   | MF7, dopo il fornitore email (D11). Su Telegram il numero arriva solo se l'utente lo condivide con un pulsante |
| Benvenuto con il nome dell'organizzazione                                                                               |  🟡   | Il bot conosce l'organizzazione; manca la personalizzazione del testo                                          |
| Promemoria delle scadenze                                                                                               |  ✅   | Sempre attivi                                                                                                  |
| Avvisi di cambio stato delle pratiche                                                                                   |  🔴   | Il sistema di invio in chat esiste già                                                                         |
| Web app leggera installabile                                                                                            |  🟡   | La dashboard funziona già per i soci (ruolo collaboratore); va resa installabile                               |
| Accesso alla web app con link dalla chat                                                                                |  ⛔   | Dopo MF7                                                                                                       |
| Pagamenti                                                                                                               | 🔴⛔  | Fornitore di pagamenti (H3)                                                                                    |

---

## 3. Vincoli esterni

### 3.1 Fatturazione e pagamenti

- In Italia la fattura tra aziende è **elettronica** e passa dal Sistema di Interscambio: va integrato un fornitore (es. Fatture in Cloud, Aruba, altri), non costruito in casa.
- I pagamenti vanno affidati a un fornitore (es. Stripe): i dati delle carte non devono mai passare da SinfonIA.
- Prima del fornitore servono il modello di prezzo (H2) e l'elenco di ciò che si misura (§4.1).

### 3.2 Canali di messaggistica

- **Telegram**: il bot può scrivere solo a chi lo ha avviato; nessun costo per messaggio; pulsanti e menu disponibili.
- **WhatsApp Business**: i messaggi inviati per primi dall'organizzazione richiedono **modelli approvati da Meta**, consenso esplicito del destinatario e sono **a pagamento per conversazione**; fuori dalla finestra di 24 ore solo modelli. Le comunicazioni massive vanno progettate su questi vincoli.

### 3.3 Dati personali

- **Storico dei messaggi, chat dal vivo, scheda completa del socio**: salvare i testi cambia informativa, tempi di conservazione e valutazione d'impatto.
- **Etichette automatiche sul comportamento**: è profilazione, con obblighi propri.
- **Documenti d'identità letti automaticamente**: possibile, con minimizzazione (solo i campi necessari) e conservazione definita.
- Le domande corrispondenti sono aggiunte a `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, sezione G.

### 3.4 Infrastruttura

Uptime, SLA e monitoraggio dei server dipendono dall'hosting UE di produzione (F4), ancora da scegliere.

---

## 4. Moduli nuovi: proposta tecnica

### 4.1 Misurazione dei consumi (L1, base della fatturazione)

- Contatori giornalieri per organizzazione in una tabella dedicata: membri attivi, pratiche create, documenti letti, chiamate e token IA, minuti di audio trascritti, messaggi in chat in entrata e in uscita.
- Solo conteggi, mai contenuti (principio 2).
- Visibili nella console (L1) e, per la propria organizzazione, nel pannello dei costi (L2).

### 4.2 Validazione dei dati letti (L2 + L3)

- **Dashboard**: elenco dei documenti da verificare; per ciascuno i campi estratti, modificabili, con «Conferma». I valori confermati diventano i dati ufficiali della pratica e la correzione resta nel registro.
- **Chat**: dopo il caricamento il bot mostra i campi principali con i pulsanti `Conferma` / `Modifica`; «Modifica» rimanda la persona alla web app o chiede il campo da correggere.
- Stati del documento: letto → da verificare → confermato (o corretto).

### 4.3 Pulsanti e menu in chat (L3)

- Menu fisso con le azioni principali; pulsanti al posto delle opzioni scritte nelle domande del bot (oggi l'utente deve riscriverle).
- «Parla con un operatore»: nella prima versione crea una richiesta visibile nella dashboard e avvisa gli operatori; la chat dal vivo vera e propria segue H5.

### 4.4 Moduli verticali

- Un modulo = tipi di pratica, campi, categorie di scadenza, modelli di documenti e istruzioni IA del settore, attivabile per organizzazione dalla console («funzioni attive», B15 rinviata in FE7).
- Primo verticale (H1, approvato): **agricoltura**, per la rete d'imprese agricole TerreFVG (§4.6). Contenuti da definire con le aziende del pilota; dal documento di partenza: quaderno di campagna, fascicolo aziendale, carburante agevolato, certificazioni BIO (la categoria di scadenza «Certificazione biologica» esiste già).
- Verticali successivi, come esempi:
  - **cooperativa musicale e spettacolo**: agibilità ex ENPALS, borderò, rendicontazione ingaggi, note spese (il modulo `music` esiste già);
  - **artigianato e reti d'impresa**: formazione obbligatoria, bandi e finanziamenti, scadenze contributive.

### 4.5 Ruoli personalizzati

Ruoli definiti dall'organizzazione come insiemi di permessi del catalogo esistente (mai permessi nuovi inventati dall'interfaccia), con regole di perimetro (proprie pratiche, assegnate, tutta l'organizzazione).

### 4.6 Conseguenze del pilota TerreFVG (H1)

Una rete d'imprese è fatta di **più aziende**, ciascuna con i propri dati, e di una **rete** che le coordina. Per il pilota questo comporta:

1. **Struttura**: un'organizzazione di tipo «Rete d'impresa» (TerreFVG) e un'organizzazione di tipo «Azienda» per ogni impresa agricola, collegate da un'adesione confermata dall'azienda (piano fase 1, §1.2). Le aziende si creano dalla console (FE7).
2. **Cosa vede la rete**: per principio approvato, **solo l'anagrafica minima delle aderenti e statistiche aggregate**, mai i dati delle singole aziende (§1.3 del piano). Se la rete deve lavorare sulle pratiche di un'azienda (es. una segreteria comune), serve una **delega** concessa dall'azienda.
3. **Tappe che diventano necessarie per il pilota**: MF9 (reti, adesioni, aggregati) e MF8 (deleghe), con le pagine FE9 (aderenti, statistiche, adesioni, deleghe). Erano in attesa di **D4** (soglia e indicatori aggregati) e **D3** (durata delle deleghe): queste due decisioni vanno prese prima di avviare il pilota.
4. **Modulo agricolo**: nuovo modulo (oggi il modulo predefinito delle nuove organizzazioni è `music`), con tipi di pratica, campi, scadenze e istruzioni IA del settore; da definire con TerreFVG.
5. **Ordine aggiornato**: l'ondata A resta invariata; nell'ondata B il primo modulo verticale (B1) diventa agricolo e si aggiungono MF8, MF9 e FE9 (B5, §5).

---

## 5. Ondate di lavoro

| Ondata | Contenuto                                                                      | Stima (giorni) | Dipende da           |
| :----: | :----------------------------------------------------------------------------- | :------------: | :------------------- |
| **A**  | A1 validazione dei dati letti (dashboard e chat)                               |      5–6       | —                    |
|        | A2 pulsanti e menu su Telegram, richiesta «parla con un operatore»             |       3        | —                    |
|        | A3 avvisi in chat ai cambi di stato delle pratiche                             |       1        | —                    |
|        | A4 vista Kanban e assegnazione delle pratiche                                  |      3–4       | —                    |
|        | A5 FE8: salute del sistema e consumi IA nella console                          |       3        | —                    |
| **B**  | B1 primo modulo verticale: agricoltura (TerreFVG)                              |      8–12      | H1                   |
|        | B2 ruoli personalizzati                                                        |      4–5       | H6                   |
|        | B3 misurazione dei consumi e pannello dei costi                                |      4–5       | H2                   |
|        | B4 backup giornaliero automatico (punto 6)                                     |       1        | —                    |
|        | B5 rete e deleghe per il pilota: MF9, MF8 e pagine FE9                         |     10–14      | D3, D4               |
| **C**  | C1 MF7: riconoscimento in chat, link alla web app, collegamento chat–dashboard |      4–5       | D11                  |
|        | C2 messaggi vocali                                                             |      2–3       | chiave Mistral       |
|        | C3 WhatsApp attivo                                                             |      2–3       | H4, Meta             |
|        | C4 storico dei messaggi e chat dal vivo                                        |      6–8       | H5, consulenza       |
|        | C5 monitoraggio dei server e SLA                                               |      4–6       | hosting (F4)         |
| **D**  | D1 abbonamenti e fatturazione con fornitore esterno                            |      8–10      | H2, H3               |
|        | D2 comunicazioni massive e segmentate                                          |      5–6       | H4, H5               |
|        | D3 primo connettore gestionale                                                 |      6–10      | H8                   |
|        | D4 catalogo dei moduli e dei modelli IA                                        |   da stimare   | due verticali attivi |

**Ondata A: circa 15–17 giorni**, nessuna decisione bloccante. Le stime sono indicative e non comprendono le attese esterne (Meta, fornitori, consulenza).

Le tappe già pianificate restano valide: FE5 (rifinitura e pubblicazione), FE9 (sezioni per tipo, con MF8 e MF9), FE10 (accesso eccezionale).

---

## 6. Rischi

| Rischio                                                      | Mitigazione                                                                           |
| :----------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| Funzioni di profilazione o storico chat senza base giuridica | Decisione H5 e consulenza prima dello sviluppo                                        |
| Costi WhatsApp imprevisti con le comunicazioni massive       | Telegram come canale principale del pilota (H4); limiti e conteggi per organizzazione |
| Moduli verticali troppo generici                             | Un verticale alla volta, costruito con un'organizzazione pilota reale                 |
| Fatturazione costruita in casa e non conforme                | Fornitore di fatturazione elettronica (H3)                                            |
| Promesse di uptime senza hosting adeguato                    | SLA solo dopo la scelta dell'hosting (F4)                                             |

---

## 7. Decisioni (approvate il 31/10/2026)

| #   | Tema                                              | Decisione                                                                                                             |
| :-- | :------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------- |
| H1  | Primo verticale del pilota                        | **rete d'imprese agricole TerreFVG** (www.terrefvg.it), modulo agricolo; conseguenze in §4.6                          |
| H2  | Modello di prezzo                                 | canone per organizzazione più quota per socio attivo, con crediti IA inclusi e oltre soglia a consumo                 |
| H3  | Fornitori di fatturazione elettronica e pagamenti | da scegliere all'avvio dell'ondata D, con contratto e nomina a responsabile del trattamento                           |
| H4  | Canale principale del pilota                      | Telegram; WhatsApp in un secondo momento, dopo la configurazione su Meta e la stima dei costi                         |
| H5  | Salvataggio dello storico dei messaggi            | non ora; da decidere dopo la consulenza (abilita la chat dal vivo e la scheda completa del socio)                     |
| H6  | Ruoli personalizzati                              | sì, come insiemi di permessi del catalogo, gestiti dall'amministratore dell'organizzazione                            |
| H7  | Ordine delle ondate                               | A → B → C (secondo gli sblocchi) → D                                                                                  |
| H8  | Primo gestionale da collegare                     | quello usato dall'organizzazione pilota, se ne usa uno                                                                |
| H9  | Validazione dei dati letti                        | obbligatoria per i documenti «da verificare», facoltativa per gli altri; i dati confermati diventano quelli ufficiali |
| H10 | «Parla con un operatore» nella prima versione     | richiesta registrata e avviso agli operatori, senza chat dal vivo                                                     |
