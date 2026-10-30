# SinfonIA — Frontend, seconda versione: area dell'organizzazione e console di piattaforma

**Stato**: proposta da approvare · **Data**: 30/10/2026 · **Versione**: 1
**Riferimenti**: `docs/PROGETTO_FRONTEND_V1.md` (pagine P1–P10, tappe FE0–FE5), `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (modello organizzativo §1, deleghe §2.4, permessi §3, RLS §6, accesso eccezionale §7, conservazione §8)

Questo documento estende la dashboard della prima versione in tre direzioni:

- **area dell'organizzazione**: le sezioni che mancano a tutte le organizzazioni (home con indicatori, impostazioni, registro attività);
- **sezioni per tipo di organizzazione**: reti d'impresa, consorzi, associazioni di categoria, studi professionali, aziende;
- **console di piattaforma**: la gestione generale di SinfonIA da parte del super admin.

Le scelte segnate **G1–G9** (§9) sono decisioni del proprietario. Nessuna migrazione, dipendenza o modifica allo staging viene fatta prima dell'approvazione.

---

## 1. Principi

1. **Una sola dashboard per tutte le organizzazioni.** Il tipo di organizzazione decide quali sezioni compaiono in più, non quali permessi si hanno (§1.1 del piano: «il tipo abilita solo relazioni e funzioni»).
2. **Ogni organizzazione ha i propri dati.** Pratiche, scadenze, export e persone esistono per tutti i tipi, anche per una rete o un'associazione.
3. **Una rete non vede i dati delle aziende aderenti.** Vede l'anagrafica minima degli aderenti e statistiche aggregate sopra una soglia (§1.2–1.3 del piano). Per vedere dati serve una delega concessa dall'azienda (MF8).
4. **Il super admin gestisce, non legge.** La console di piattaforma mostra organizzazioni, stato e funzionamento del sistema, ma non pratiche, documenti o dati delle persone. L'unica eccezione è l'accesso eccezionale approvato dall'organizzazione (§7 del piano), da implementare più avanti.
5. **Il frontend non è un confine di sicurezza.** Ogni permesso resta deciso dal backend a ogni richiesta, come nella prima versione.

---

## 2. Situazione verificata (30/10/2026)

| Elemento                                     | Stato                                                                                                                                                                            |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tipo di organizzazione                       | nello schema (`tenant.type`: COMPANY, NETWORK, CONSORTIUM, TRADE_ASSOCIATION, ASSOCIATION, PROFESSIONAL_FIRM, OTHER); **nessun tipo «cooperativa»** (oggi ricade in COMPANY)     |
| Stato dell'organizzazione                    | nello schema (`ACTIVE`, `SUSPENDED`, …); il controllo dei permessi rifiuta già l'accesso se l'organizzazione non è `ACTIVE`                                                      |
| Adesioni alle reti (`organization_relation`) | tabella presente, **nessun codice la usa**                                                                                                                                       |
| Deleghe (`access_grant`, beneficiari)        | tabelle presenti, **nessun codice le usa** (MF8, in attesa di D3)                                                                                                                |
| Ruolo di piattaforma (`user.platform_role`)  | campo presente (`NONE`, `PLATFORM_ADMIN`), **nessun codice lo usa**                                                                                                              |
| Creazione delle organizzazioni               | solo da script (`scripts/tenant.provision.ts`), con un admin a email segnaposto e codice d'invito del modello precedente                                                         |
| Registro attività                            | eventi già registrati in `audit_log` (accessi, inviti, ruoli, revoche, pratiche, scadenze, export); permesso `audit.read` già assegnato agli ADMIN; **nessuna rotta di lettura** |
| Tracce dell'assistente IA                    | `GET /ai/traces` per l'organizzazione; modello, fornitore, esito, tempi e token per ogni chiamata                                                                                |
| RLS                                          | esclusa (§6 del piano): l'isolamento tra organizzazioni è nel codice. Le letture trasversali della console vanno quindi in un servizio dedicato e separato                       |

---

## 3. Area dell'organizzazione: nuove pagine comuni

| #   | Pagina                      | Chi                  | Contenuto e azioni                                                                                                                                                  | Dipende da |
| :-- | :-------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------- |
| P11 | Home con indicatori         | tutti, nel perimetro | pratiche per stato; scadenze dei prossimi 30 giorni e scadute; documenti da rivedere (lettura incerta); ultime attività. MEMBER: solo i propri dati                 | B10        |
| P12 | Impostazioni organizzazione | ADMIN                | nome e tipo (il tipo in sola lettura, lo cambia la piattaforma); promemoria delle scadenze; export pianificato dell'organizzazione; canali collegati (sola lettura) | B12        |
| P13 | Registro attività           | ADMIN                | eventi con data, persona, tipo e canale; filtri per periodo, tipo e persona; nessun contenuto dei documenti                                                         | B11        |
| P14 | Utilizzo dell'assistente    | ADMIN                | chiamate all'assistente per periodo ed esito; errori; nessun testo delle richieste                                                                                  | già pronta |
| P15 | Collegamento della chat     | tutti                | dal profilo: collegare e scollegare Telegram/WhatsApp con un codice                                                                                                 | MF7, D11   |

---

## 4. Sezioni per tipo di organizzazione

### 4.1 Pagine

| #   | Pagina                     | Chi                                           | Contenuto e azioni                                                                                                | Dipende da |
| :-- | :------------------------- | :-------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :--------- |
| P16 | Aderenti                   | ADMIN della rete                              | aziende aderenti con anagrafica minima; richieste di adesione in attesa; invito ad aderire; fine dell'adesione    | MF9        |
| P17 | Statistiche aggregate      | ADMIN e OPERATOR della rete                   | solo indicatori di un elenco approvato; «non disponibile» sotto la soglia di aziende; periodi fissi               | MF9, D4    |
| P18 | Le mie adesioni            | ADMIN dell'azienda                            | reti di cui l'azienda fa parte; richieste ricevute da confermare o rifiutare; uscita                              | MF9        |
| P19 | Deleghe concesse           | ADMIN dell'azienda                            | chi può vedere o fare che cosa, su quali dati, fino a quando; beneficiari nominativi; revoca                      | MF8, D3    |
| P20 | Deleghe ricevute (clienti) | ADMIN e OPERATOR dell'organizzazione delegata | aziende che hanno delegato; ambito e scadenza; accesso ai soli dati delegati, con indicazione chiara dell'azienda | MF8, D3    |

### 4.2 Quali sezioni per quale tipo (proposta, G5)

| Tipo                              | Pagine comuni (P1–P15) | Aderenti, statistiche (P16–P17) | Adesioni, deleghe concesse (P18–P19) | Deleghe ricevute (P20) |
| :-------------------------------- | :--------------------: | :-----------------------------: | :----------------------------------: | :--------------------: |
| Azienda (e cooperativa, vedi G6)  |           sì           |                —                |                  sì                  |           —            |
| Rete d'impresa                    |           sì           |               sì                |                  sì                  |           —            |
| Consorzio                         |           sì           |               sì                |                  sì                  |      su richiesta      |
| Associazione di categoria         |           sì           |               sì                |                  sì                  |           sì           |
| Associazione                      |           sì           |          su richiesta           |                  sì                  |           —            |
| Studio professionale (consulente) |           sì           |                —                |                  sì                  |           sì           |
| Altro                             |           sì           |                —                |                  sì                  |           —            |

«Su richiesta» significa: la piattaforma attiva la funzione per quella singola organizzazione. Il menu mostra solo le sezioni attive; il backend rifiuta comunque le chiamate alle funzioni non attive.

---

## 5. Console di piattaforma (super admin)

### 5.1 Pagine

| #   | Pagina                     | Contenuto e azioni                                                                                                                                                                                        | Dipende da     |
| :-- | :------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------- |
| A1  | Organizzazioni             | elenco con tipo, stato, data di creazione, numero di membri e di pratiche, ultima attività; ricerca e filtri                                                                                              | B14            |
| A2  | Nuova organizzazione       | nome, tipo, modulo; invito del primo amministratore per email (sostituisce lo script con email segnaposto)                                                                                                | B14, MF6       |
| A3  | Dettaglio organizzazione   | dati della pagina A1; contatto degli amministratori (G3); funzioni attive (§4.2); modulo, scheduler, integrazione webhook; **sospensione e riattivazione**. Disattivazione e cancellazione solo dopo MF10 | B14, B15       |
| A4  | Stato del sistema          | servizi attivi; esecuzioni dello scheduler e errori; messaggi in uscita in attesa o falliti; coda di lettura dei documenti; spazio di archiviazione; file orfani; esito e data dell'ultimo backup         | B16            |
| A5  | Consumi dell'assistente IA | chiamate e token per organizzazione, fornitore e mese; errori e tempi; costo stimato. Nessun testo delle richieste                                                                                        | B17            |
| A6  | Registro della piattaforma | tutte le azioni dei super admin: chi, quando, su quale organizzazione, che cosa                                                                                                                           | B18            |
| A7  | Accesso eccezionale        | richiesta motivata, approvazione dell'organizzazione, durata massima, chiusura (§7 del piano)                                                                                                             | D9, più avanti |

**Fuori dalla console**: la nomina di un super admin (G4) e qualsiasi lettura di pratiche, documenti, scadenze o dati delle persone.

### 5.2 Accesso e sicurezza della console (proposta, G1–G2)

1. **Area separata della stessa app**: `/app/piattaforma`, visibile solo a chi ha `PLATFORM_ADMIN`.
2. **Token separato**: il token di piattaforma (10 minuti) non è legato a un'organizzazione e non vale sulle rotte delle organizzazioni; un token di organizzazione non vale sulle rotte `/platform/*`. Essere super admin **non** rende membri di alcuna organizzazione.
3. **Ruolo letto dal database a ogni richiesta**, come per i membri: togliere `PLATFORM_ADMIN` ha effetto subito.
4. **Verifica recente**: per entrare nella console serve un codice inserito nelle ultime 12 ore; per le azioni critiche (sospensione, nuova organizzazione) se ne chiede uno nuovo. Un secondo fattore (app di autenticazione o passkey) è proposto come tappa successiva (G2), con nuova dipendenza da approvare.
5. **Registro dedicato** (B18): ogni azione della console viene registrata nel registro della piattaforma e, se riguarda un'organizzazione, anche nel suo registro attività, così l'organizzazione vede che cosa è stato fatto.
6. **Letture trasversali isolate**: un solo servizio (`src/core/platform/`) legge tra organizzazioni, solo conteggi e metadati, con un test che vieta l'accesso a contenuti di pratiche, allegati e scadenze da quel servizio.

---

## 6. API da aggiungere nel backend

| #   | Modifica                                                                                                                        | Per   |               Migrazione                |
| :-- | :------------------------------------------------------------------------------------------------------------------------------ | :---- | :-------------------------------------: |
| B10 | `GET /dashboard/summary`: conteggi per stato, scadenze vicine, documenti da rivedere, nel perimetro di chi chiede               | P11   |                   no                    |
| B11 | `GET /audit`: eventi paginati con filtri; permesso `audit.read`; contenuto filtrato (nessun dato dei documenti, nessun segreto) | P13   |                   no                    |
| B12 | `GET /organization`, `PATCH /organization`: impostazioni modificabili dall'ADMIN                                                | P12   |                   no                    |
| B13 | `POST /auth/token` con ambito «piattaforma» e verifica recente; permessi di piattaforma separati da quelli delle organizzazioni | A1–A7 |                   no                    |
| B14 | `GET /platform/organizations`, `POST /platform/organizations`, `GET /platform/organizations/:id`                                | A1–A3 |                   no                    |
| B15 | `POST /platform/organizations/:id/suspend`, `…/reactivate`, `…/features`                                                        | A3    | sì (funzioni attive per organizzazione) |
| B16 | `GET /platform/system`: stato di scheduler, messaggi in uscita, coda OCR, archiviazione, file orfani, ultimo backup             | A4    |                   no                    |
| B17 | `GET /platform/ai-usage`: aggregati per organizzazione, fornitore e mese                                                        | A5    |                   no                    |
| B18 | Registro della piattaforma: nuova tabella (il registro attuale richiede sempre un'organizzazione)                               | A6    |                   sì                    |
| B19 | Tipo `COOPERATIVE`, solo se approvato (G6)                                                                                      | §4.2  |                   sì                    |

Le API di adesioni, statistiche e deleghe (P16–P20) fanno parte di MF8 e MF9 e verranno descritte nei rispettivi piani.

Le migrazioni (B15, B18, B19) seguono la regola già in vigore: prima su copia, poi sullo staging solo con approvazione separata.

---

## 7. Tappe

| Tappa | Contenuto                                                                                                                       |      Stima (giorni)      | Dipende da         |
| :---: | :------------------------------------------------------------------------------------------------------------------------------ | :----------------------: | :----------------- |
|  FE4  | Persone e inviti (P8–P9), già prevista                                                                                          |            3             | —                  |
|  FE6  | Home con indicatori, impostazioni, registro attività, utilizzo assistente (P11–P14; B10–B12)                                    |            4             | FE4                |
|  FE7  | Console di piattaforma, prima parte: accesso, organizzazioni, nuova, dettaglio, sospensione, registro (A1–A3, A6; B13–B15, B18) |           6–7            | FE4, G1–G4         |
|  FE8  | Console, seconda parte: stato del sistema e consumi IA (A4–A5; B16–B17)                                                         |            3             | FE7                |
|  FE5  | Test end-to-end, accessibilità, rifinitura mobile, pubblicazione sullo staging (anche delle nuove pagine)                       |           3–4            | FE4, FE6, FE7      |
|  FE9  | Sezioni per tipo: adesioni, aderenti, statistiche, deleghe (P16–P20)                                                            | da stimare con MF8 e MF9 | MF8 (D3), MF9 (D4) |
| FE10  | Collegamento della chat (P15) e accesso eccezionale (A7)                                                                        |        da stimare        | MF7 (D11), D9      |

**Totale stimato FE4–FE8 più FE5: 19–21 giorni di lavoro.** Le stime sono indicative.

L'ordine proposto (G8) mette prima la console perché sostituisce gli script per creare le organizzazioni ed è necessaria per accogliere il pilota; FE9 e FE10 partono quando le decisioni rinviate saranno prese.

---

## 8. Sicurezza e dati personali

- Le nuove pagine rispettano le regole del §6 della prima versione (token in memoria, cookie protetto, nessun dato personale in `localStorage`, cache azzerata al cambio di organizzazione).
- **Passaggio tra organizzazione e piattaforma**: come un cambio di organizzazione: nuovo token, cache azzerata.
- **Registro attività**: mostra persone ed eventi, non contenuti. La durata di conservazione dell'audit dipende dalla verifica legale (D10): fino ad allora si mostra ciò che esiste.
- **Statistiche delle reti**: calcolate dal server, solo sopra soglia; il browser non riceve mai dati delle singole aziende.
- **Console**: i contatti degli amministratori sono dati personali; vanno inclusi nell'informativa (domanda da aggiungere a `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, insieme al trattamento dei dati di utilizzo dell'assistente per organizzazione).

---

## 9. Decisioni richieste

| #   | Decisione                        | Proposta                                                                                                                                                         |
| :-- | :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Dove sta la console              | area `/app/piattaforma` della stessa app, con token separato. Alternativa: app separata su un indirizzo dedicato e raggiungibile solo da rete fidata             |
| G2  | Verifica per la console          | v1: codice email recente (12 ore) e nuovo codice per le azioni critiche; poi secondo fattore (app di autenticazione o passkey)                                   |
| G3  | Che cosa vede la console         | conteggi, stati, date e contatto degli amministratori; nessun nome di pratica, documento, scadenza o altro dato delle persone                                    |
| G4  | Chi nomina i super admin         | solo uno script sul server, con registrazione; mai dall'interfaccia. Almeno due super admin per non restare senza accesso                                        |
| G5  | Sezioni per tipo                 | tabella del §4.2, con attivazione «su richiesta» decisa dalla piattaforma                                                                                        |
| G6  | Tipo «cooperativa»               | aggiungerlo (B19): permette in futuro funzioni e scadenze specifiche delle cooperative; oggi si comporta come un'azienda                                         |
| G7  | Indicatori della home (P11)      | pratiche per stato, scadenze dei prossimi 30 giorni e scadute, documenti da rivedere, ultime 10 attività                                                         |
| G8  | Ordine delle tappe               | FE4, FE6, FE7, FE8, FE5; poi FE9 e FE10 quando le decisioni D3, D4, D9 e D11 saranno prese                                                                       |
| G9  | Sospensione di un'organizzazione | blocca subito l'accesso dei membri da dashboard, API e chat; i dati restano intatti; i membri vedono «organizzazione sospesa»; la riattivazione ripristina tutto |

---

## 10. Come si collega al resto

- **Piano della fase 1**: P16–P20 sono l'interfaccia di MF8 (deleghe) e MF9 (reti); A7 è l'interfaccia di §7 (accesso eccezionale); la disattivazione e la cancellazione delle organizzazioni da A3 arrivano con MF10.
- **Prima versione**: P1–P10 restano invariate. La home attuale (riquadri di accesso) diventa P11.
- **Cronoprogramma (Fase 5)**: A4 e A5 sono la prima parte del monitoraggio; la telemetria completa (OpenTelemetry) resta una tappa a parte.
