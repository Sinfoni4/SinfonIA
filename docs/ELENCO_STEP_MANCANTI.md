# SinfonIA — Elenco completo degli step implementativi mancanti

**Data**: 05/11/2026 · **Base**: `main` dopo la PR #47 · **Fonti**: `docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md` (ondate A–D, decisioni H1–H10), `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (micro-fasi MF, decisioni D), `docs/PROGETTO_FRONTEND_V2.md` (tappe FE, pagine P e A, API B), `docs/CRONOPROGRAMMA_EVOLUTIVO.md` (fasi 3–5), `docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`, verifiche fatte sullo staging.

Le stime sono in giorni di lavoro, indicative, e non comprendono le attese esterne (fornitori, Meta, consulenza). Ogni migrazione, dipendenza nuova, servizio a pagamento e intervento sullo staging o in produzione richiede un'approvazione separata al momento dell'esecuzione.

---

## 0. Situazione al 05/11/2026

**Fatto e in `main`, attivo sullo staging**: identità, appartenenze, revoca, ruoli PostgreSQL separati, backup cifrato manuale (Fase 1, MF0–MF5, MF8 in parte); dashboard per le organizzazioni (FE0–FE4, FE6); console di piattaforma con salute del sistema e consumi IA (FE7, FE8); **ondata A completa**: verifica dei dati letti (A1), pulsanti e menu su Telegram (A2), avvisi di cambio stato e «parla con un operatore» (A3, H10), bacheca e assegnazione (A4), salute e consumi IA (A5). Decisioni D3 e D4 approvate.

**Da provare sul bot vero** (codice pronto, mai provato dal vivo): pulsanti e menu, avvisi di cambio stato, richieste di assistenza, avviso di assegnazione.

---

## 1. Lavori senza blocchi, in ordine consigliato

### 1.1 B5 — Rete d'imprese e deleghe per il pilota TerreFVG (10–14 gg)

Necessario al pilota: oggi le tabelle esistono (`organization_relation`, `access_grant`, `access_grant_beneficiary`) ma nessun codice le usa.

**MF9 — Reti, adesioni e statistiche aggregate**

1. Servizio delle adesioni: richiesta di adesione dalla rete, conferma o rifiuto da un amministratore dell'azienda, fine dell'adesione da entrambe le parti; stati `PENDING`, `ACTIVE`, `ENDED`; audit di ogni passaggio.
2. Anagrafica minima delle aderenti visibile alla rete (nome, comune, settore): nuovi campi dell'organizzazione se mancano (migrazione).
3. Regola di autorizzazione: l'adesione **non** dà alcun permesso sui dati dell'azienda (test dedicato).
4. Motore delle statistiche (D4): indicatori I1–I7 calcolati sul server; soglia di 5 aziende per valore, «meno di 3» per i conteggi di 1–2 aziende; periodi fissi (mese, trimestre, anno) e categorie fisse; uscita dagli aggregati dal periodo successivo al ritiro; registrazione di ogni consultazione.
5. API: `GET/POST /network/members`, `POST /network/members/:id/end`, `GET /memberships` (lato azienda), `POST /memberships/:id/confirm|reject|leave`, `GET /network/stats?period=…`.
6. Test: rete senza delega non vede nulla delle aziende; soglia e conteggi piccoli; nessun filtro libero; azienda ritirata.

**MF8 — Deleghe (D3)**

7. Servizio delle deleghe: concessione da un amministratore dell'azienda a una persona o a un'organizzazione; ambito (tipi di dato, eventuali pratiche o categorie) e operazioni esplicite (`READ`, `CREATE`, `UPDATE`, `APPROVE`, `DELETE`, `EXPORT`).
8. Durate D3: scadenza obbligatoria, massimo 12 mesi (3 se include `DELETE` o `EXPORT`), predefinita 12 mesi; rinnovo solo esplicito; revoca immediata; stato «scaduta» calcolato.
9. Beneficiari nominativi per le deleghe a organizzazioni: proposti dalla beneficiaria, approvati dal concedente; un nuovo membro non riceve nulla senza approvazione; chi lascia la beneficiaria perde l'accesso.
10. Estensione del servizio di autorizzazione: perimetro «delega» accanto a «proprie» e «organizzazione», verificato a ogni richiesta (delega attiva, beneficiario approvato e attivo, oggetto e operazione nell'ambito).
11. Rotte di accesso ai dati delegati: l'organizzazione delegata lavora sulle pratiche dell'azienda indicando l'azienda; tutto registrato nel registro dell'azienda con riferimento alla delega.
12. Avvisi al concedente 30 e 7 giorni prima della scadenza (chat ed email), come compiti dello scheduler.
13. Export con delega che include `EXPORT` (regole D5 già pronte).
14. Test previsti dal piano: consulente fuori delega (#6), beneficiario non approvato, delega scaduta o revocata, rete senza delega (#8).

**FE9 — Pagine per tipo di organizzazione (G5)**

15. P16 Aderenti e P17 Statistiche (rete), P18 Le mie adesioni e P19 Deleghe concesse (azienda), P20 Deleghe ricevute (organizzazione delegata), con indicazione chiara dell'azienda su cui si lavora.
16. **Funzioni attive per organizzazione** (B15, rinviata da FE7): migrazione, `POST /platform/organizations/:id/features`, menu che mostra solo le sezioni attive, backend che rifiuta le funzioni non attive.
17. Console: creazione delle aziende e della rete TerreFVG (già possibile), più collegamento rete–aziende avviato dalla console o dalla rete.

### 1.2 B4 — Backup giornaliero automatico (1 gg)

18. Compito pianificato che esegue il backup cifrato ogni notte, con controllo di leggibilità, rotazione delle copie e avviso in console se fallisce o se il supporto manca.
19. Mostrare in «Salute del sistema» la data e l'esito dell'ultimo backup.
20. Sul PC attuale la pianificazione richiede di cambiare la configurazione del sistema: va approvata; in produzione va sul server.

### 1.3 Completamento di A5 / FE8 (1–2 gg)

Rispetto alla pagina A4 del piano frontend mancano:

21. Coda di lettura dei documenti (OCR in attesa e in corso).
22. Spazio di archiviazione occupato e file orfani (lo script `storage:orphans` esiste).
23. Esito e data dell'ultimo backup (dopo B4).
24. Costo stimato dei consumi IA per organizzazione e mese (tariffe del fornitore in configurazione).

### 1.4 B1 — Modulo agricolo (8–12 gg, contenuti da TerreFVG)

25. Raccolta con le aziende del pilota: tipi di pratica, campi, scadenze e documenti tipici (quaderno di campagna, fascicolo aziendale, carburante agevolato, certificazioni BIO).
26. Tipi di pratica e campi del modulo `agri` (oggi il modulo predefinito delle nuove organizzazioni è `music`), con schema del payload e validazione.
27. Categorie di scadenza agricole aggiuntive e promemoria.
28. Istruzioni IA del settore e scenari dell'harness di valutazione in italiano agricolo.
29. Campi di lettura dei documenti specifici (es. fatture di carburante agricolo) e loro verifica (A1).
30. Scelta del modulo alla creazione dell'organizzazione dalla console.

### 1.5 FE5 — Rifinitura e pubblicazione della dashboard (3–4 gg)

31. Test end-to-end nel browser dei percorsi principali (login, pratiche, verifica documenti, bacheca, assistenza, console).
32. Verifica di accessibilità (tastiera, lettori di schermo, contrasti) e correzioni.
33. Rifinitura per telefono di tutte le pagine (bacheca compresa).
34. Pubblicazione della dashboard insieme al backend nello stesso processo di rilascio (oggi sullo staging la build va fatta a mano con `npm run web:build`).

### 1.6 B2 — Ruoli personalizzati (4–5 gg, H6)

*Fatto sul ramo `feat/b2-custom-roles` (migrazione `20261107090000_b2_custom_roles`, solo sul database dei test)*: un ruolo personalizzato parte da un ruolo di base e ne tiene solo alcuni permessi o li limita alle proprie pratiche, mai di più; vale su API, chat e assistente IA; resta sempre almeno un amministratore che gestisce le persone; un ruolo non passa tra organizzazioni (controllo anche nel database). Il perimetro «pratiche assegnate» è rinviato: richiede di cambiare tutte le query delle pratiche.

35. Tabella dei ruoli dell'organizzazione come insiemi di permessi del catalogo esistente, con perimetro (proprie, assegnate, organizzazione); migrazione.
36. Servizio di autorizzazione che li applica; mai permessi inventati dall'interfaccia.
37. Pagina dell'amministratore per crearli e assegnarli; audit.

### 1.7 B3 — Misurazione dei consumi e pannello dei costi (4–5 gg, H2)

38. Contatori per organizzazione: soci attivi, crediti IA (token), messaggi inviati, documenti letti.
39. Pannello dei costi per l'organizzazione e riepilogo in console; base per la futura fatturazione (D1).

### 1.8 Rifiniture e completamenti minori (1–3 gg in tutto)

40. Tradurre in italiano gli avvisi della lettura dei documenti (es. «Low OCR confidence», «VAT number … found without its label»).
41. Benvenuto in chat con il nome dell'organizzazione.
42. «Assegnata a» nella pagina di dettaglio della pratica e nel suo elenco.
43. Scheda del socio con membri, pratiche, scadenze e documenti in una vista unica (senza storico chat, che dipende da H5).
44. Export in Excel e JSON accanto al CSV; PDF di riepilogo della pratica.
45. Dashboard installabile come web app sul telefono (manifest e icone).
46. Pulizia periodica del database di test, che cresce a ogni esecuzione e rallenta i test (es. il controllo MF3).

---

## 2. Lavori bloccati da una decisione o da un elemento esterno

| # | Lavoro | Bloccato da | Stima |
| :- | :--- | :--- | :- |
| 47 | **MF6 completo**: invio reale dei codici di accesso e degli inviti per email (oggi simulato e spento in produzione) | **D11** fornitore email | 1–2 |
| 48 | **MF7 / C1**: collegamento chat–account con codice monouso; link alla web app dalla chat; riconoscimento senza attrito | D11, poi MF6 | 4–5 |
| 49 | **FE10, P15**: collegare e scollegare Telegram/WhatsApp dal profilo | MF7 | 1–2 |
| 50 | **FE10, A7**: accesso eccezionale dell'amministratore tecnico (richiesta motivata, approvazione, durata, chiusura) | **D9** | da stimare |
| 51 | Secondo fattore per la console (app di autenticazione o passkey, G2) | scelta della tecnologia, eventuale dipendenza nuova | 2–3 |
| 52 | **MF10, MF13**: conservazione e cancellazione dei dati; disattivazione e cancellazione delle organizzazioni dalla console | **D10**, consulenza legale (sezione D) | da stimare |
| 53 | Regole di cancellazione delle pratiche R1–R13 e correzione dei file orfani | **D6b / C3** | 2–3 |
| 54 | Recupero degli account con email segnaposto; fusione di account | **D8** | 2–3 |
| 55 | **C2** Messaggi vocali (trascrizione) | chiave **Mistral** | 2–3 |
| 56 | **C3** WhatsApp attivo: configurazione Meta, modelli approvati con pulsanti, prova con numero reale | **H4**, verifica Meta Business, costi | 2–3 |
| 57 | **C4** Storico dei messaggi, chat dal vivo operatore–socio, risposta dalla dashboard a «parla con un operatore» | **H5**, consulenza (G1) | 6–8 |
| 58 | **C5** Monitoraggio dei server, uptime, SLA, OpenTelemetry e metriche (Fase 5) | hosting di produzione **F4** | 4–6 |
| 59 | **D1** Abbonamenti e fatturazione elettronica alle organizzazioni; pagamenti | **H2**, **H3** fornitori, consulenza (G5) | 8–10 |
| 60 | **D2** Comunicazioni massive e segmentate | H4, H5, consulenza (G4) | 5–6 |
| 61 | **D3 / Fase 4A** Primo connettore gestionale (es. Odoo multi-azienda per le reti) | **H8**: gestionale usato da TerreFVG | 6–10 |
| 62 | **Fase 4B** Connettori PA e di categoria (INPS ex-ENPALS, SIAE, fatturazione SDI) | accordi e accessi agli enti | da stimare |
| 63 | **D4** Catalogo dei moduli e dei modelli IA per settore | almeno due verticali attivi | da stimare |
| 64 | Etichette automatiche sul comportamento dei soci | profilazione: consulenza (G2) | da stimare |
| 65 | Lettura automatica dei documenti d'identità | consulenza (G3) | da stimare |
| 66 | Rilevamento delle anomalie di sicurezza (accessi sospetti, picchi) | dati di produzione, hosting | da stimare |

---

## 3. Verifiche e qualità ancora da fare

67. Prova sul bot vero di A2, A3 e A4 (pulsanti, menu, avvisi, assistenza, assegnazione) sullo staging.
68. Prova dello scadenzario e dei promemoria con il bot reale (fase 3C).
69. Misura dell'accuratezza della lettura su documenti reali (fase 3B, `docs/PROTOCOLLO_PROVA_OCR.md`), in particolare documenti agricoli del pilota.
70. Prova delle pagine «Salute» e «Consumi IA» sullo staging con un gestore della piattaforma (`npm run platform:admin`).
71. Prova di carico con la Fase 1 e le nuove funzioni sul database di test.
72. **MF12** Pulizia delle colonne del modello precedente (`user.tenant_id`, `user.role`, `user.telegram_id`) dopo il periodo di verifica.
73. RLS limitata (`practice`, `practice_attachment`, `audit_log`) solo se decisa in futuro, alle condizioni del piano (§6).

---

## 4. Messa in produzione e pilota TerreFVG

74. Scelta dell'hosting UE di produzione (F4) e del fornitore email (D11).
75. Ambiente di produzione: database con ruoli separati, archiviazione degli allegati, segreti, backup giornaliero cifrato e prova di ripristino, processo di rilascio con build della dashboard.
76. Consulenza legale e privacy: ruolo della piattaforma e contratto con le organizzazioni (A1–A2), sub-responsabili (A3), informative (A5), registro dei trattamenti e valutazione d'impatto (A6), statistiche e deleghe (E1–E2).
77. Configurazione del pilota dalla console: organizzazione «Rete d'impresa» TerreFVG, un'organizzazione «Azienda» per ogni impresa, adesioni confermate, primi amministratori invitati.
78. Collegamento a Telegram dei soci e degli operatori; breve formazione sull'uso della chat e della dashboard.
79. Avvio con 2–3 aziende, raccolta dei riscontri, correzioni, poi estensione a tutte le aderenti.

---

## 5. Ordine consigliato

1. Prove sul bot vero (67) e piccole rifiniture (40–42): qualche ora.
2. **B5** (1–17), necessario al pilota.
3. B4 backup automatico (18–20) e completamento di A5 (21–24).
4. B1 modulo agricolo (25–30), appena arrivano i contenuti da TerreFVG; in parallelo FE5 (31–34).
5. Decisioni da prendere per sbloccare la produzione: **D11** (email), **F4** (hosting), consulenza legale; poi MF6–MF7 (47–49) e produzione (74–76).
6. Pilota (77–79).
7. Dopo il pilota: B2, B3, ondata C secondo gli sblocchi, ondata D (H7).

**Stima dei lavori senza blocchi (sezione 1)**: circa 35–50 giorni, di cui B5 + B1 + FE5 (il minimo per il pilota) circa 21–30.
