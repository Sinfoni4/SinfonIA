# SinfonIA — Elenco completo degli step implementativi mancanti

**Data**: 27/11/2026 · **Base**: `main` dopo la PR #115 · **Fonti**: `docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md` (ondate A–D, decisioni H1–H10), `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (micro-fasi MF, decisioni D), `docs/PROGETTO_FRONTEND_V2.md`, `docs/CRONOPROGRAMMA_EVOLUTIVO.md`, `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, verifiche sul codice e sullo staging su VPS.

Le stime sono in giorni di lavoro, indicative, e non comprendono le attese esterne (fornitori, Meta, consulenza). Ogni migrazione, dipendenza nuova, servizio a pagamento e intervento sullo staging o in produzione richiede un'approvazione separata al momento dell'esecuzione.

Questa versione sostituisce quella del 24/11/2026: le voci fatte nel frattempo sono riassunte nella sezione 0 e non compaiono più tra quelle da fare. La sezione 0bis riassume lo stato per settore dell'utilizzatore finale (agricoltura, artigianato, musica).

---

## 0. Situazione al 27/11/2026

**Fatto e in `main`, attivo sullo staging** (`https://staging.synfonia.it`, VPS Aruba in Italia):

- Identità, appartenenze, revoca, ruoli PostgreSQL separati; colonne del modello precedente rimosse (MF12).
- Accesso con codice via **email vera** (SMTP `noreply@synfonia.it`, MF6/D11); SPF, DKIM e DMARC (`p=none`) attivi sul dominio.
- Collegamento verificato della chat con `/accedi` e link personali di Telegram (AGX-10, MF7 in parte).
- Dashboard delle organizzazioni (aspetto dashboard-01), console di piattaforma con salute del sistema, archivio allegati, ultimo backup e consumi IA.
- **Ondata A completa** (verifica dei dati letti, pulsanti e menu, avvisi, «parla con un operatore», bacheca e assegnazione).
- **B5** reti d'imprese, adesioni, statistiche aggregate (MF9, D4) e deleghe (MF8, D3), con le pagine per tipo di organizzazione.
- **B4** backup notturno cifrato fatto dall'applicazione, con controllo di ripristino mostrato in console.
- **B2** ruoli personalizzati (anche «proprie e assegnate»); **B3** eventi di consumo e report (tariffe `USAGE_RATES` non ancora impostate).
- AGX-01…AGX-12: ricezione sicura dei documenti, identificativi d'impresa, titolare della pratica, deleghe operative, checklist e richieste di documenti, lettura OCR in background con nuovi tentativi, documenti in chat.
- **Mini App Telegram** (con assistente, logo e colori dell'organizzazione).
- **Moduli di settore** musicale, agricolo (`agri`) e artigiano; funzioni di settore accese a parte per dashboard e Mini App, con **registri** (allegati, export CSV/Excel/PDF, scadenze collegate intitolate con il tipo di voce, persona da avvisare, consultazione e compilazione con delega). Dettaglio per settore nella sezione 0bis.
- Assistente IA su **Mistral** (`mistral-small-latest`, fornitore UE).
- Export in Excel e PDF accanto al CSV (il PDF va a capo nelle celle lunghe); avvisi OCR in italiano; benvenuto con il nome dell'organizzazione; pulizia del database di test; dashboard installabile; test end-to-end e di accessibilità nella CI; `TRUST_PROXY` dietro nginx.

---

## 0bis. Stato per settore dell'utilizzatore finale

La **parte comune** (accesso, organizzazioni, reti e deleghe, ruoli, pratiche, documenti e OCR, scadenzario e promemoria, Mini App, assistente IA, export, backup) vale per tutti i settori. Ogni settore aggiunge un **modulo** (tipi di pratica, campi, sotto-stati, documenti attesi, istruzioni per l'IA) e, se previste, **funzioni di settore** (registri con scadenze, allegati, export, persona da avvisare e delega).

| Settore | Modulo pratiche | Funzioni di settore | Pronto per un pilota |
|---|---|---|---|
| Agricoltura (TerreFVG) | ✅ | 7 su 7 | Sì, da configurare con i dati reali |
| Artigianato (Confartigianato) | ✅ | 3 su 6 | In parte |
| Musica (cooperative musicali) | ✅ | nessuna definita | Solo per le pratiche |

### Agricoltura (TerreFVG) — completo

**Fatto**

- Modulo `agri`: pratica «Agricola» (domanda PAC, bando di sviluppo rurale, certificazione biologica, altro), anno di campagna e termine di presentazione; sotto-stati raccolta documenti, istruttoria, integrazione richiesta; documenti attesi fascicolo aziendale, documento del titolare, visura, certificato BIO (con scadenza).
- Funzioni di settore, tutte pronte (PR #108, #109, #112):

| Funzione | Contenuto | Stato |
|---|---|---|
| Quaderno di campagna | Trattamenti e lavorazioni per appezzamento, quantità con unità | ✅ |
| Abilitazioni e patentini | Patentini e abilitazioni delle persone con rinnovo | ✅ |
| Documento di valutazione dei rischi | Revisioni del DVR e figure della sicurezza | ✅ |
| Fascicolo e scadenze PAC | Aggiornamenti del fascicolo, domande e pagamenti | ✅ |
| Carburante agricolo (UMA) | Assegnazione annuale e prelievi | ✅ |
| Certificazioni BIO | Certificato, programma annuale di produzione, visite ispettive | ✅ |
| Formazione e sicurezza | Corsi, visite mediche, DPI consegnati | ✅ |

- Persona da avvisare (patentini, corsi, visite mediche, PR #113), registri con delega (PR #114), titoli delle scadenze con il tipo di voce (PR #115), PDF con celle a capo (PR #110).
- Dati dimostrativi in TerreFVG (prova) in tutti i 7 registri.

**Manca**: verifica dei contenuti dei registri con TerreFVG (voce 4), misura dell'OCR sui documenti agricoli reali (36), configurazione reale del pilota e collegamento delle persone (37–39), connettore al gestionale (29, bloccato da H8).

### Artigianato (Confartigianato) — a metà

**Fatto**

- Modulo `artisan`: pratica «Artigiana» (avvio o variazione d'impresa, abilitazione o patentino, formazione obbligatoria, bando o contributo, rifiuti e ambiente, altro) con termine di presentazione; stessi sotto-stati dell'agricoltura; documenti attesi documento del titolare, visura, DURC (con scadenza).
- Funzioni di settore pronte, condivise con l'agricoltura: Documento di valutazione dei rischi, Formazione e sicurezza, Abilitazioni e patentini (anche impianti e F-gas).

| Funzione | Stato |
|---|---|
| Documento di valutazione dei rischi | ✅ |
| Formazione e sicurezza | ✅ |
| Abilitazioni e patentini | ✅ |
| Bandi e contributi | ❌ in preparazione (voce 1) |
| Avvio e variazioni d'impresa (SCIA, albo delle imprese artigiane, pratiche camerali) | ❌ in preparazione (voce 1) |
| Rifiuti: registri e MUD (carico e scarico, formulari, RENTRI) | ❌ in preparazione (voce 1) |

**Manca**: le 3 funzioni proprie (1), un'organizzazione di prova artigiana con dati dimostrativi (3), WhatsApp come canale principale (8, bloccato da Meta e costi).

### Musica (cooperative musicali) — solo pratiche

**Fatto**

- Modulo `music`, il settore da cui SinfonIA è partito: pratica «Musicale» (data e luogo dell'evento, sotto-stati «Contratto da firmare» e «In attesa del pagamento», documenti attesi contratto di scrittura e certificato di agibilità) e pratica «Artista» (nome d'arte, documento d'identità).

**Manca**: le funzioni di settore, oggi nessuna nemmeno «in preparazione» (2); un'organizzazione di prova musicale con dati dimostrativi (3); i connettori INPS ex-ENPALS, SIAE e fatturazione SDI (30, bloccati da accordi e accessi agli enti).

---

## 1. Funzioni di settore

Fatti nel frattempo e tolti dall'elenco: le 5 funzioni agricole già «in preparazione», il promemoria alla persona indicata nella voce, i registri con delega, quantità e unità in un solo campo nel PDF.

1. **Artigianato — le 3 funzioni ancora «in preparazione»**: bandi e contributi (bandi segnalati alle imprese e raccolta delle adesioni), avvio e variazioni d'impresa (SCIA, albo delle imprese artigiane, pratiche camerali), rifiuti (registro di carico e scarico, formulari, RENTRI, MUD annuale). Contenuti da raccogliere con Confartigianato. (2–3 gg ciascuna)
2. **Musica — definire le funzioni di settore** con una cooperativa: per esempio calendario degli eventi, agibilità INPS ex-ENPALS per evento, borderò e programmi SIAE, contratti e compensi per artista. Poi costruirle come registri, come per gli altri settori. (da stimare dopo la definizione)
3. **Organizzazioni di prova** artigiana e musicale su staging, con dati dimostrativi come TerreFVG (prova).
4. **Agricoltura — verifica dei contenuti** dei 7 registri con TerreFVG (campi, scelte, scadenze), con le correzioni che ne escono.

## 2. Canali per documenti e messaggi

5. **Caricamento via email** su `documenti@synfonia.it` (alias già creato, consegna nella casella di `noreply`): solo mittenti registrati che superano SPF/DKIM, cartella «Da smistare» nella dashboard dell'organizzazione, assegnazione a pratica o voce, email originale cancellata dopo l'importazione. Serve l'indirizzo IMAP di Register.it. (3–4 gg)
6. **Link o QR di caricamento** a scadenza, per una sola pratica o voce, per persone esterne. (2 gg)
7. **C2 Messaggi vocali** trascritti (chiave Mistral ora disponibile; oggi il bot risponde che non li gestisce). (2–3 gg)
8. **C3 WhatsApp** attivo: configurazione Meta, modelli approvati con pulsanti, prova con numero reale. *Bloccato da* H4, verifica Meta Business, costi. (2–3 gg)
9. **C4 Storico dei messaggi** e chat dal vivo operatore–socio, risposta dalla dashboard a «parla con un operatore». *Bloccato da* H5, consulenza (G1). (6–8 gg)
10. Collegare e scollegare Telegram/WhatsApp dal profilo: verificare cosa manca rispetto ai link personali esistenti (FE10, P15).

## 3. Pratiche e dashboard

11. «Assegnata a» nel dettaglio e nell'elenco delle pratiche (oggi solo in bacheca).
12. PDF di riepilogo di una singola pratica.
13. Decidere se amministratori e operatori possono caricare documenti nelle pratiche dei soci (oggi `attachment.create` è solo sulle proprie pratiche, per ogni ruolo).
14. Prova manuale con un lettore di schermo (NVDA o VoiceOver); capire perché nella CI il service worker dell'app installabile non risulta registrato (`web/e2e/installable.spec.ts`).

## 4. Sicurezza e accessi

15. Secondo fattore per la console di piattaforma (app di autenticazione o passkey, G2). (2–3 gg)
16. **FE10/A7** Accesso eccezionale dell'amministratore tecnico (richiesta motivata, approvazione, durata, chiusura). *Bloccato da* D9.
17. Recupero degli account con email segnaposto e fusione di account. *Bloccato da* D8. (2–3 gg)
18. Rilevamento di anomalie di sicurezza (accessi sospetti, picchi).

## 5. Dati e privacy

19. **MF10/MF13** Conservazione e cancellazione dei dati; disattivazione e cancellazione delle organizzazioni dalla console. *Bloccato da* D10 e consulenza legale.
20. Regole di cancellazione delle pratiche R1–R13 e pulizia dei file orfani. *Bloccato da* D6b / C3. (2–3 gg)
21. Consulenza legale e privacy: ruolo della piattaforma e contratto con le organizzazioni, sub-responsabili (ora anche Aruba e Mistral), informative, registro dei trattamenti, valutazione d'impatto, statistiche e deleghe.
22. DMARC da `p=none` a `p=quarantine` dopo 2–4 settimane di report puliti (report su `admin@synfonia.it`).

## 6. Infrastruttura

23. **Backup fuori dal server**: oggi le copie notturne restano sul VPS.
24. Prova di ripristino di un backup sul VPS (database e allegati).
25. **Script di installazione nel repository** (archivio di `main`, build, backup cifrato, migrazione come owner, cambio versione con `app.prev`, controlli), oggi tenuto fuori dal progetto.
26. **C5** Monitoraggio: disponibilità, avvisi se il servizio cade, metriche (OpenTelemetry, Fase 5). (4–6 gg)
27. Ambiente di produzione separato da staging quando si parte con dati reali (hosting F4, database con ruoli separati, segreti, backup, rilascio).
28. Rimozione dei dati dimostrativi (note «Dato dimostrativo», pratiche con `demo: true`) da TerreFVG (prova) quando non servono più.

## 7. Integrazioni

29. **D3 / Fase 4A** Primo connettore gestionale (es. Odoo multi-azienda per le reti). *Bloccato da* H8: gestionale usato da TerreFVG. (6–10 gg)
30. **Fase 4B** Connettori PA e di categoria (INPS ex-ENPALS, SIAE, fatturazione SDI). *Bloccato da* accordi e accessi agli enti.

## 8. Modello commerciale e funzioni avanzate

31. **D1** Abbonamenti e fatturazione elettronica alle organizzazioni; pagamenti; tariffe `USAGE_RATES`. *Bloccato da* H2, H3, consulenza (G5). (8–10 gg)
32. **D2** Comunicazioni massive e segmentate. *Bloccato da* H4, H5, consulenza (G4). (5–6 gg)
33. **D4** Catalogo dei moduli e dei modelli IA per settore.
34. Etichette automatiche sul comportamento dei soci (profilazione, G2) e lettura automatica dei documenti d'identità (G3). *Bloccati da* consulenza.

## 9. Verifiche e pilota TerreFVG

35. Prova completa sul bot reale con `docs/PROVA_BOT_REALE.md`, compresi scadenzario e promemoria.
36. Misura dell'accuratezza della lettura sui circa 40 documenti reali del protocollo (`docs/PROTOCOLLO_PROVA_OCR.md`), soprattutto agricoli.
37. Configurazione reale del pilota dalla console: rete TerreFVG, un'organizzazione «Azienda» per ogni impresa, adesioni confermate, primi amministratori invitati.
38. Collegamento a Telegram di soci e operatori; breve formazione su chat, Mini App e dashboard.
39. Avvio con 2–3 aziende, raccolta dei riscontri, correzioni, poi estensione a tutte le aderenti.

---

## 10. Ordine consigliato

1. Lavori senza blocchi utili al pilota: funzioni artigiane (1) e organizzazioni di prova (3), caricamento via email (5) e link (6), messaggi vocali (7), backup fuori dal server e prova di ripristino (23–24), script di installazione (25).
2. Rifiniture brevi: 11, 12, 13 (dopo la decisione), 14.
3. Pilota (35–39) con la verifica dei registri agricoli (4); in parallelo la definizione delle funzioni musicali con una cooperativa (2).
4. Decisioni da prendere per sbloccare: consulenza legale (19, 21), produzione (27), WhatsApp (8), gestionale (29).
5. Dopo il pilota: secondo fattore (15), monitoraggio (26), ondata C e D secondo gli sblocchi.
