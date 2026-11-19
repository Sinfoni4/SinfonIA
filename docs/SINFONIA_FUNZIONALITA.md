# SinfonIA — Funzionalità e implementazioni realizzate

Stato al 06/11/2026, ramo `main` (ultima unione: PR #62).

Il documento ha due parti:

- la **parte A** descrive che cosa fa oggi SinfonIA, per area;
- la **parte B** elenca, in ordine di tempo, le implementazioni realizzate.

In fondo c'è un riepilogo di ciò che manca ancora.

---

## A. Funzionalità di SinfonIA

### A1. Che cos'è

SinfonIA gestisce le **pratiche** di organizzazioni come cooperative, reti di imprese e aziende, con i loro soci e collaboratori. Si usa da tre punti di accesso:

- una **chat** su Telegram o WhatsApp, con un assistente IA che capisce il linguaggio naturale;
- una **dashboard web** per l'organizzazione, che si può installare sul telefono;
- una **console di piattaforma** per chi gestisce SinfonIA.

Più organizzazioni convivono sulla stessa installazione, ognuna isolata dalle altre.

Il sistema è diviso in un **Core comune** e in **moduli verticali**. I moduli disponibili sono «Generico», che è il predefinito, «Musica e spettacolo» e «Agricoltura».

### A2. Organizzazioni, persone e accessi

**Organizzazioni e appartenenze**
- Una persona può appartenere a più organizzazioni, con un ruolo diverso in ciascuna, e sceglie con quale lavorare.
- Ruoli di base: amministratore, operatore e socio o collaboratore.
- Il cambio di ruolo e la revoca hanno effetto già alla richiesta successiva.
- I canali di chat sono collegati alla persona: la persona viene riconosciuta con il suo account Telegram o il suo numero WhatsApp.

**Ruoli personalizzati**

Ogni organizzazione può creare ruoli propri, a partire da un ruolo di base e senza mai dare più di quello. Per ogni permesso il ruolo indica un perimetro:

- **solo le proprie** pratiche;
- **proprie e assegnate**, solo per la lettura delle pratiche e dei documenti;
- **tutta l'organizzazione**.

**Accesso alla dashboard**
- Si entra con un **codice di 6 cifre via email**: non ci sono password.
- Gli **inviti** si mandano per email, con un link.
- Le sessioni scadono e si possono chiudere.
- Finché non c'è un servizio di posta, in sviluppo, staging e demo il codice compare sullo schermo. Lo staging risponde solo da questo PC.

**Autorizzazione**
- Un servizio centrale controlla ogni permesso e il suo perimetro.
- Le funzioni si possono spegnere per singola organizzazione.
- Ogni pagina e ogni comando della chat rispettano permessi e perimetro.

### A3. Pratiche

**Gestione**
- Si possono creare, cercare, filtrare, aprire ed eliminare, con conferma.
- Hanno un ciclo di stati: creata → validata → inviata → completata, oppure non riuscita.
- I moduli aggiungono le loro **fasi intermedie**, per esempio «raccolta documenti», «in esame» e «integrazione richiesta».

**Tipi e campi**
- Ogni modulo definisce i tipi di pratica, i campi specifici e i documenti attesi.
- I campi del modulo compaiono nella scheda della pratica.

**Assegnazione e bacheca**
- Una pratica si può assegnare a una persona.
- La **bacheca Kanban** mostra le pratiche per stato e permette di spostarle, con una conferma.

**Allegati**
- Si caricano foto e PDF, dalla chat o dalla dashboard.
- I file vanno in un archivio locale oppure su S3 o MinIO.
- Ci sono limiti di dimensione e di tipo, e il controllo dei percorsi.
- Un report in sola lettura segnala i file orfani.

**Protezione da doppie operazioni**: lo stesso cambio di stato, la stessa eliminazione o la stessa richiesta inviati due volte hanno effetto una volta sola.

### A4. Lettura dei documenti (OCR) e verifica

- L'**OCR** lavora sul server, in un thread separato, su foto e PDF.
  - I PDF vengono anche rasterizzati.
  - Le foto poco leggibili hanno una seconda lettura.
  - Ci sono etichette per i fornitori ricorrenti.
- I dati letti (importi, partite IVA, date, fornitore) diventano proposte da verificare.
- La sezione **«Da verificare»** raccoglie i documenti letti in attesa di conferma o correzione da parte di una persona.

### A5. Scadenze e promemoria

- Ogni organizzazione ha il suo **scadenzario** degli adempimenti, da chat e da dashboard.
- I **promemoria** partono a 30, 15, 7 e 1 giorno dalla scadenza, nel canale della persona.
- Le scadenze si possono chiudere. Nella scheda socio compaiono quelle aperte, con i giorni che mancano.

### A6. Chat (Telegram e WhatsApp)

**Canali**
- Telegram e WhatsApp Business funzionano allo stesso modo.
- Su Telegram ci sono anche pulsanti e un menu principale.

**Linguaggio naturale**

L'assistente capisce richieste come «crea una pratica per…» o «a che punto è…».

- Se manca un dato, fa una domanda; una risposta breve completa la richiesta.
- Corregge gli errori di battitura sui comandi.
- Risponde ai messaggi vocali.

Comandi riconosciuti:
- lista pratiche;
- pratiche azienda;
- stato pratica;
- crea, valida, completa ed elimina pratica;
- scadenze e nuova o chiudi scadenza;
- export pratiche;
- attiva o disattiva l'export pianificato.

**Sicurezza delle azioni dell'IA**
- L'IA **non cambia mai lo stato di una pratica da sola**: propone il cambio e chiede «Sì / No».
- Senza ruolo o senza un permesso noto, l'IA non esegue l'azione.
- Le eliminazioni chiedono conferma e alla conferma la pratica viene ricontrollata.

**Vista predefinita**: in chat si vedono le proprie pratiche. Quelle dell'organizzazione si vedono solo su richiesta esplicita e con il permesso.

**Avvisi di cambio stato**: chi segue una pratica riceve un messaggio quando cambia stato.

**Allegati in chat**: quando arriva un file, la chat chiede a quale pratica appartiene.

**Assistenza**: con «parla con un operatore» si apre una richiesta, che gli operatori trovano nella sezione Assistenza della dashboard.

### A7. Intelligenza artificiale

- I fornitori sono selezionabili: OpenAI, oggi usato in staging con `gpt-4o-mini`, oppure **Mistral AI**, con server nell'UE.
- La modalità IA è esplicita e si può spegnere (`ENABLE_LLM`).
- L'output è strutturato, con riparazione automatica se non è valido e domande di chiarimento.
- Contro la **prompt injection** i dati sono delimitati e l'input viene controllato.
- I **dati personali** vengono ridotti al minimo prima dell'invio al fornitore.
- Le **tracce** registrano ogni chiamata: fornitore, modello, token, tempi ed esito, mai il testo.
- Un insieme di casi di riferimento permette di misurare la qualità dell'IA (harness di valutazione).
- La console mostra i **consumi** dell'IA per organizzazione.

### A8. Reti di imprese e deleghe

**Reti e adesioni**
- Una rete raccoglie aziende tramite **adesioni**, che possono essere in attesa o attive.
- La rete vede solo **statistiche aggregate** delle aziende, non i loro dati.
- Gli inviti nella rete partono dall'organizzazione o dalla console.

**Deleghe** (regole D3)
- Un'azienda può dare a un consulente esterno l'accesso alle proprie pratiche.
- La delega indica le operazioni ammesse (lettura, modifica) e dura al massimo 12 mesi, contati sul giorno italiano.
- Si può rinnovare e revocare, e il consulente può esportare.
- Il consulente vede le pratiche delegate in una sezione apposita.

### A9. Export

- L'export delle pratiche si può fare da chat e da dashboard, con le regole D5.
- L'**export pianificato** è attivo solo per chi lo sceglie (opzione D5b).

### A10. Dashboard web dell'organizzazione

| Sezione | Contenuto |
|---|---|
| Home | Numeri principali dell'organizzazione |
| Pratiche | Elenco, ricerca, nuova pratica, dettaglio con stati, allegati e campi del modulo |
| Bacheca | Kanban per stato, assegnazione |
| Scadenze | Scadenzario |
| Da verificare | Documenti letti dall'OCR da confermare |
| Assistenza | Richieste «parla con un operatore» |
| Export | Export e export pianificato |
| Deleghe | Deleghe date e ricevute, pratiche delegate |
| Rete, Statistiche, Adesioni | Per le reti e per le aziende che ne fanno parte |
| Persone | Membri, inviti, ruoli e ruoli personalizzati |
| Scheda socio | Per una persona: ruolo, pratiche create e assegnate, scadenze aperte, documenti da verificare |
| Attività | Registro delle attività e uso dell'assistente IA |
| Impostazioni | Impostazioni dell'organizzazione |
| Profilo | Dati della persona |

Caratteristiche generali:

- **Uso da telefono**: c'è un menu apposito e nessuna pagina scorre di lato.
- **Installabile**: manifest, icone e service worker. Il service worker conserva sul dispositivo solo i file della dashboard, mai i dati.
- **Accessibilità**: collegamento «Vai al contenuto», etichette dei campi e nomi dei comandi, testo alternativo delle immagini, contrasti di livello WCAG AA, tutto controllato in automatico.
- **Layout stabile**: header e contenuto non si spostano passando da una sezione all'altra.
- **Aspetto grafico**: Tailwind CSS e shadcn/ui.

### A11. Console di piattaforma

- **Organizzazioni**: creazione, scelta del modulo, funzioni attive, sospensione e riattivazione, legami con le reti.
- Le azioni sensibili richiedono un **codice di conferma**.
- **Registro** delle azioni di piattaforma.
- **Salute del sistema**:
  - database;
  - code dell'outbox;
  - attività pianificate;
  - lettura dei documenti;
  - archivio degli allegati;
  - ultimo backup, con avviso oltre 7 giorni;
  - ultima **verifica del ripristino**, con avviso se è fallita o ha più di 30 giorni.
- **Consumi IA** per organizzazione.

### A12. Infrastruttura e affidabilità

**Database**
- PostgreSQL 17 con Prisma.
- Tre **ruoli separati**: migrazioni, applicazione con privilegi minimi, backup.
- Isolamento tra organizzazioni e indici sui dati delle pratiche.

**Scheduler durevole**: lock consultivi senza perdite, identità di sistema propria.

**Outbox**
- Consegna con tentativi ripetuti e coda dei messaggi non consegnabili.
- Canali: Telegram, WhatsApp e webhook.
- Chi è stato revocato non riceve gli avvisi già in coda.

**Backup**
- Backup **cifrati** su chiavetta USB.
- Ripristino cifrato.
- `npm run db:verify-backup` ripristina l'ultimo backup in un database temporaneo e lo confronta con il manifest.

**Ambienti**
- Test, staging (porta 3110) e demo su dati sintetici (porta 3200) sono separati.
- `staging:start` controlla porta e database e compila la dashboard prima di avviare.

**Qualità**
- CI su GitHub con lint, formattazione, tipi, oltre 600 test backend, test della dashboard ed e2e con Playwright, su computer e telefono.
- Scansione dei segreti.
- Fine riga uniformi.
- Versioni dei pacchetti fissate.

**Sicurezza HTTP**: validazione degli input, limiti e gestione uniforme degli errori.

---

## B. Implementazioni realizzate, in ordine di tempo

### 26–28/10/2026 — Fondamenta (prima delle PR)
- Fase 0: base di sicurezza e qualità.
- Fase 1: isolamento delle organizzazioni e autenticazione.
- Fase 2A–2D: dominio canonico delle pratiche, API REST, indice sui dati, scheduler durevole, outbox, gate di validazione.
- Fase 3A–3D:
  - modalità IA esplicita, tracce e recupero del contesto;
  - output strutturato, chiarimenti e prima versione dell'OCR;
  - difesa da prompt injection, minimizzazione dei dati personali, GDPR;
  - harness di valutazione e gate finale.

### 28/10/2026
| PR | Implementazione |
|---|---|
| #1 | Correzioni post-audit, Document AI (OCR, S3/MinIO, Telegram), CI funzionante |
| #2 | Dispatcher dell'outbox con retry, dead letter, Telegram e webhook |
| #3 | Scadenzario con promemoria a 30/15/7/1 giorni |
| #4 | Correzioni dalla prova con il bot Telegram reale |
| #5 | OCR dei PDF in un worker thread |

### 29/10/2026
| PR | Implementazione |
|---|---|
| #6 | OCR: seconda lettura delle foto, etichette dei fornitori |
| #7 | Canale WhatsApp Business alla pari di Telegram |
| #8 | Sicurezza IA e HTTP, tracce IA, scalabilità, valutazione con il modello reale |
| #9 | MF2: servizio di autorizzazione centrale |
| #10 | MF0: prova di backup e ripristino |
| #11 | Documentazione: gate della Fase 3 e piano della Fase 1 |
| #12 | Igiene del repository e scansione dei segreti |

### 30/10/2026
| PR | Implementazione |
|---|---|
| #13 | MF1: ruoli PostgreSQL separati |
| #14 | MF3: schema per organizzazioni, identità e deleghe |
| #15 | MF4: appartenenze al posto dell'azienda unica |
| #16, #24 | MF5: revoca immediata, cambio di ruolo, identità di sistema dello scheduler |
| #17 | MF2b: in chat le proprie pratiche come vista predefinita |
| #18, #25, #27 | Documentazione: decisioni, consulenza legale, piano v10, frontend v1 |
| #19 | Mistral AI come fornitore selezionabile |
| #20 | Backup e ripristino cifrati, procedura di aggiornamento dello staging |
| #21 | Regole di export D5 ed export pianificato su scelta |
| #22 | Report dei file allegati orfani |
| #23 | MF6: login con codice via email, sessioni e inviti |
| #26 | Chat tollerante agli errori di battitura, vocali, avvio dello staging |
| #28 | FE0: prerequisiti del backend per la dashboard |
| #29 | FE1: dashboard, accesso, scelta dell'azienda, profilo |
| #30 | Il database resta attivo quando si ferma lo staging |
| #31 | FE2: pratiche nella dashboard |
| #32 | Demo su dati sintetici (`web:demo`) |
| #33 | FE3: scadenze ed export nella dashboard |
| #34 | Piano frontend v2 |
| #35 | FE4: persone e inviti |

### 31/10/2026
| PR | Implementazione |
|---|---|
| #36 | FE6: numeri della home, impostazioni, registro attività |
| #37 | FE7: console di piattaforma, prima parte |
| #38 | Chat: una risposta breve completa la richiesta |
| #39 | Staging: accesso alla dashboard con codice sullo schermo, solo da questo PC |
| #40 | Valutazione e piano dell'architettura a tre livelli |

### 04/11/2026
| PR | Implementazione |
|---|---|
| #41 | A1: verifica dei dati letti dai documenti |
| #42 | A2: pulsanti e menu in Telegram |
| #43 | A3: avvisi di stato in chat; H10: «parla con un operatore» |
| #44 | Decisioni D3 e D4 approvate |
| #45 | A4: bacheca Kanban e assegnazione |
| #46 | A5/FE8: salute del sistema e consumi IA in console |
| #47 | Correzione: schede della bacheca non più larghe della colonna |

### 05/11/2026
| PR | Implementazione |
|---|---|
| #48 | Elenco completo degli step mancanti |
| #49 | B5/MF9: reti, adesioni, statistiche aggregate |
| #50 | B5/MF8: deleghe con le regole D3 |
| #51 | FE5: Tailwind e shadcn/ui, menu per telefono, accessibilità (prima parte) |
| #52 | FE5: test e2e con Playwright |
| #53 | Fase 0 di sicurezza e integrità (S01–S10): conferme per l'IA, blocco senza contesto, test di isolamento e di doppio invio, tracce IA dalla chat |
| #54 | Fase 1: Core e moduli verticali, funzioni per organizzazione |
| #55 | Modulo generico predefinito, testi neutri della chat, dati demo del pilota, campi del modulo nella scheda |
| #56 | Inviti di aziende in una rete dalla console |
| #57 | MF12 passi 1–3: le vecchie colonne non sono più usate come fonte |
| #58 | Console: documenti da leggere, archivio, ultimo backup |
| #59 | B2/H6: ruoli personalizzati |

### 06/11/2026
| PR | Implementazione |
|---|---|
| #61 | Scheda socio, dashboard installabile, controlli di accessibilità, verifica del ripristino, perimetro «proprie e assegnate»; correzione delle deleghe rifiutate dopo mezzanotte |
| #62 | Header e contenuto non si spostano più tra le sezioni |

In bozza: **#60**, la contrazione MF12, da unire solo alla fine del periodo di verifica.

---

## C. Che cosa manca ancora

**Si può fare subito**
- Costo stimato dell'IA in console.
- Rinominare `artistName` nel contratto dell'IA.

**Aspetta una decisione**
- Contrazione MF12, dopo il periodo di verifica.
- Secondo fattore di accesso alla console.
- MF13: disattivazione e cancellazione delle organizzazioni (D10 e parere legale).
- Backup e verifica del ripristino automatici.
- Monitoraggio esterno e notifiche tecniche.
- Produzione e hosting (F4).
- Servizio email (D11).

**Aspetta TerreFVG**
- Contenuto del modulo agricolo.
- Configurazione del pilota.

**Da fare a mano**
- Prova di accessibilità con tastiera e lettore di schermo.

**Opzionali**
- Deleghe con le operazioni `CREATE`, `APPROVE` e `DELETE`.
- Promemoria delle deleghe via email.
