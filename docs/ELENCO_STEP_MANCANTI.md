# SinfonIA — Elenco completo degli step implementativi mancanti

**Data**: 24/11/2026 · **Base**: `main` dopo la PR #110 · **Fonti**: `docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md` (ondate A–D, decisioni H1–H10), `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (micro-fasi MF, decisioni D), `docs/PROGETTO_FRONTEND_V2.md`, `docs/CRONOPROGRAMMA_EVOLUTIVO.md`, `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, verifiche sul codice e sullo staging su VPS.

Le stime sono in giorni di lavoro, indicative, e non comprendono le attese esterne (fornitori, Meta, consulenza). Ogni migrazione, dipendenza nuova, servizio a pagamento e intervento sullo staging o in produzione richiede un'approvazione separata al momento dell'esecuzione.

Questa versione sostituisce quella del 05/11/2026: le voci fatte nel frattempo sono riassunte nella sezione 0 e non compaiono più tra quelle da fare.

---

## 0. Situazione al 24/11/2026

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
- **Modulo agricolo** (`agri`) e artigiano, funzioni di settore accese a parte per dashboard e Mini App; **registri** «Quaderno di campagna» e «Abilitazioni e patentini» con allegati, export CSV/Excel/PDF e scadenze collegate.
- Assistente IA su **Mistral** (`mistral-small-latest`, fornitore UE).
- Export in Excel e PDF accanto al CSV (il PDF va a capo nelle celle lunghe); avvisi OCR in italiano; benvenuto con il nome dell'organizzazione; pulizia del database di test; dashboard installabile; test end-to-end e di accessibilità nella CI; `TRUST_PROXY` dietro nginx.

---

## 1. Funzioni di settore

1. **Le 8 funzioni ancora «in preparazione»**: agricoltura — valutazione dei rischi, fascicolo e scadenze PAC, carburante agricolo, certificazioni BIO, formazione e sicurezza (anche artigiani); artigianato — bandi e contributi, avvio e variazioni d'impresa, registri rifiuti e MUD. Contenuti da raccogliere con il pilota.
2. **Promemoria al titolare della voce** (es. la scadenza del patentino avvisa anche la persona indicata, non solo gli amministratori).
3. **Registri con delega**: un consulente o una rete delegata vede o compila i registri di un'azienda entro i limiti della delega (D3).
4. Rifinitura del PDF dei registri: quantità e unità in un solo campo (es. «30 tonnellate»).

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

1. Lavori senza blocchi utili al pilota: funzioni di settore (1–3), caricamento via email (5) e link (6), messaggi vocali (7), backup fuori dal server e prova di ripristino (23–24), script di installazione (25).
2. Rifiniture brevi: 4, 11, 12, 13 (dopo la decisione), 14.
3. Pilota (35–39), con le funzioni di settore completate secondo i contenuti raccolti.
4. Decisioni da prendere per sbloccare: consulenza legale (19, 21), produzione (27), WhatsApp (8), gestionale (29).
5. Dopo il pilota: secondo fattore (15), monitoraggio (26), ondata C e D secondo gli sblocchi.
