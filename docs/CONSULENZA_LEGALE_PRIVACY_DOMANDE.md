# SinfonIA — Domande per la consulenza legale e privacy

**Data**: 29/10/2026 · **Destinatario**: consulente legale e privacy (GDPR) · **Riferimento interno**: `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` §3.5, §8, §13

Questo documento raccoglie le domande per il consulente. Prima delle domande c'è una descrizione della piattaforma. Le risposte servono a fissare le regole di conservazione, cancellazione ed esportazione prima di realizzarle. Le soluzioni tecniche indicate sono **proposte non approvate**. I riferimenti normativi indicati vanno verificati dal consulente.

---

## 1. Cosa fa la piattaforma

SinfonIA è una piattaforma per le cooperative e per le piccole aziende. Aiuta a gestire le pratiche amministrative e le scadenze di conformità: DURC, sicurezza sul lavoro, certificazioni bio, visite mediche dei lavoratori, patentini. È usata da:

- **organizzazioni clienti** (cooperative e aziende): ognuna vede solo i propri dati;
- **persone** con un ruolo in ciascuna organizzazione: amministratore, operatore o collaboratore. Una persona può appartenere a più organizzazioni;
- in futuro, **consulenti esterni** (es. commercialisti) e **reti o associazioni** di aziende, con accesso solo tramite deleghe esplicite e a tempo concesse dall'azienda;
- un **amministratore tecnico** della piattaforma. Non ha accesso ordinario ai contenuti; per casi eccezionali è progettato un accesso motivato, a tempo e registrato.

**Canali**: API e dashboard web, chat Telegram e chat WhatsApp (Meta).

**Dati trattati**

| Categoria | Esempi | Note |
| :--- | :--- | :--- |
| Identità degli utenti | email, ID numerico Telegram, numero WhatsApp | |
| Pratiche | nome della pratica (spesso nome e cognome di una persona), stato, dati compilati | |
| Documenti caricati | foto o PDF di fatture, DDT, ricevute, certificati | contengono spesso **dati di persone diverse dall'utente** |
| Dati estratti dai documenti | campi letti con l'OCR, svolto sul nostro server | |
| Scadenze di conformità | tipo, data, titolo | il tipo «visita medica» riguarda la sorveglianza sanitaria dei lavoratori |
| Registro delle operazioni (audit) | chi ha fatto cosa e quando | solo identificativi, senza contenuti |
| Log tecnici | accessi, errori | dati di contatto e testi oscurati |

**Fornitori esterni coinvolti o previsti**

| Fornitore | Ruolo | Dati che riceve | Dove |
| :--- | :--- | :--- | :--- |
| Hosting e database (da scegliere per la produzione) | infrastruttura | tutti | UE (requisito) |
| Fornitore AI, uno a scelta: OpenAI, Azure OpenAI con regione UE, oppure Mistral AI (società francese) | interpretazione dei messaggi in linguaggio naturale | testo dei messaggi. Nomi, codici fiscali, IBAN, email e telefoni sono sostituiti da segnaposto prima dell'invio, ma il riconoscimento dei nomi è euristico | USA (OpenAI); UE (Azure, Mistral) |
| Telegram | canale di chat | messaggi, file e allegati scambiati in chat | fuori UE **[da verificare]** |
| Meta (WhatsApp Business) | canale di chat | come sopra | **[da verificare]** |
| Fornitore email (non ancora scelto: SMTP Aruba, Brevo o altri) | codici di accesso, inviti, avvisi di sicurezza | indirizzo email e testo dell'avviso | Italia o UE |
| Storage dei file (filesystem del server oppure S3 Milano) | allegati | file originali | UE |

---

## 2. Domande

Ogni domanda indica la fase di sviluppo che ne dipende. Le domande **A** vanno chiarite per prime: le altre dipendono dalle loro risposte.

### A. Ruoli e contratti — priorità alta

**A1. Ruolo della piattaforma.**
Riteniamo che l'organizzazione cliente sia **titolare** dei dati delle proprie pratiche e documenti, e SinfonIA **responsabile** del trattamento (art. 28 GDPR). È corretto?
Per quali trattamenti SinfonIA è invece titolare? Ad esempio: account degli utenti, sicurezza, log, fatturazione.

**A2. Contratto con le organizzazioni (DPA).**
Quali contenuti minimi deve avere l'accordo sul trattamento dei dati con ciascuna organizzazione? Ci serve in particolare sapere:
- come autorizzare in anticipo i sub-responsabili (fornitori della tabella sopra);
- come comunicarne le variazioni.
Avete un modello da proporre?

**A3. Sub-responsabili.**
Quali verifiche e quali contratti servono con ciascun fornitore della tabella? Ci interessano soprattutto:
- **trasferimenti fuori UE**: OpenAI, Telegram, Meta. Bastano le clausole contrattuali standard o il quadro UE-USA per la privacy dei dati? Serve una valutazione d'impatto del trasferimento?
- **Fornitore AI**: la piattaforma può usare in alternativa OpenAI, Azure OpenAI in regione UE o Mistral AI.
  - Con OpenAI, per rendere accettabile l'invio di testo dopo la sostituzione dei dati personali, basta il DPA standard?
  - Quale dei tre consigliate per il pilota?
  - Per Mistral vanno verificate nel suo DPA la durata di conservazione delle richieste, la possibilità di conservazione zero ed eventuali trasferimenti temporanei fuori UE.

**A4. Canali di chat.**
Quando un utente riceve un file nella propria chat Telegram o WhatsApp, quel file esce dal nostro controllo: resta nella cronologia del servizio e sul telefono. Chi ne risponde? Cosa va scritto nell'informativa e nelle condizioni d'uso?
Abbiamo già deciso: export in chat solo delle proprie pratiche; export pianificato su Telegram solo a chi lo sceglie, in seguito sostituito da un collegamento a un download autenticato.

**A5. Informative.**
Servono più informative, e chi le fornisce? Ad esempio:
- alle persone che usano la piattaforma;
- alle persone i cui dati compaiono nei documenti caricati (dati di terzi);
- ai lavoratori per le scadenze di sorveglianza sanitaria.
Quali informazioni deve mettere a disposizione SinfonIA come responsabile?

**A6. Registro dei trattamenti e valutazione d'impatto.**
SinfonIA deve tenere un registro come responsabile (art. 30.2)?
Il trattamento richiede una valutazione d'impatto (DPIA)? Gli elementi da considerare sono:
- uso di AI;
- documenti con dati di terzi;
- possibili dati sulla salute dei lavoratori;
- molte organizzazioni sulla stessa piattaforma.

### B. Categorie particolari di dati — priorità alta

**B1. Visite mediche.**
Oggi registriamo per i lavoratori solo tipo, data di scadenza e titolo della visita medica, senza esiti. Questo rientra nei dati relativi alla salute (art. 9 GDPR)? Quali cautele servono?
Il titolo è libero: conviene vietare di scriverci nomi o informazioni sanitarie?

**B2. Documenti caricati.**
I documenti possono contenere, anche senza che lo chiediamo, dati sanitari o giudiziari: certificati medici, documenti di identità, casellario. Dobbiamo:
- limitare i tipi di documento accettati?
- avvisare l'utente al caricamento?
- applicare misure particolari (accesso, cifratura, durata)?

### C. Conservazione dei dati — riguarda la fase MF10

Le durate in tabella sono **nostre proposte**. Per ciascuna chiediamo se è ammissibile, chi la decide (titolare o responsabile) e come motivarla.

| # | Dato | Proposta | Domanda |
| :-: | :--- | :--- | :--- |
| C1 | Pratiche, documenti, dati estratti | durata del contratto con l'organizzazione | La piattaforma deve rispettare gli obblighi civilistici e fiscali di conservazione (es. art. 2220 c.c., art. 22 DPR 600/1973, art. 39 DPR 633/1972), oppure spettano solo all'azienda? Non siamo un sistema di conservazione digitale a norma: come lo dichiariamo per non essere scambiati per un archivio legale? |
| C2 | Pratiche inviate a enti (`SUBMITTED`/`COMPLETED`) | archiviazione invece di cancellazione | Devono restare come prova dell'adempimento? Per quanto e a carico di chi? |
| C3 | Dati identificativi di persone non più attive | 12 mesi dopo la fine dell'ultima appartenenza, poi anonimizzazione | È ragionevole? |
| C4 | Registro delle operazioni (audit) | 5 anni, solo identificativi | Esiste un obbligo o un termine di riferimento? Come lo si concilia con le richieste di cancellazione (art. 17)? |
| C5 | Log di sicurezza e accessi degli amministratori | 12 mesi, inalterabili | Si applica il provvedimento del Garante sugli amministratori di sistema (log degli accessi conservati almeno 6 mesi)? Con quali requisiti? |
| C6 | Backup | 30 giorni | Va bene che i dati cancellati restino nei backup fino alla loro scadenza, con accesso limitato e con la ripetizione delle cancellazioni dopo un eventuale ripristino? Cosa dire nell'informativa? |
| C7 | Codici di accesso, inviti, sessioni | da 24 ore a 30 giorni dopo la scadenza | Nessuna osservazione prevista: confermare. |
| C8 | Messaggi in coda per l'invio | 30 giorni dopo la consegna | Confermare. |
| C9 | Dati di un'organizzazione che chiude il contratto | restituzione dei dati, 30 giorni di ripensamento, poi cancellazione | Tempi e modalità di restituzione (art. 28.3.g)? |

### D. Cancellazione — riguarda le fasi MF10 e MF13

**D1. Richieste di cancellazione degli interessati (art. 17).**
Chi risponde e in quanto tempo?
- Oggi riteniamo che risponda l'organizzazione come titolare, e che la piattaforma la assista.
- Se la richiesta arriva direttamente a SinfonIA, come dobbiamo comportarci?

**D2. Eccezioni.**
Quando la cancellazione può essere rifiutata o rinviata (obbligo legale, difesa di un diritto)? Chi lo decide e come va documentato?

**D3. Dati di terzi nei documenti.**
Una persona che compare in una fattura caricata da un'azienda chiede la cancellazione. Chi risponde? Il documento può essere conservato per obblighi fiscali dell'azienda?

**D4. Registro delle cancellazioni.**
Per ripetere le cancellazioni dopo un ripristino da backup, teniamo un registro con soli identificativi. Quanto tempo possiamo conservarlo?

**D5. File di pratiche già cancellate.**
Sul server restano file di pratiche cancellate prima che correggessimo il difetto. Dobbiamo intervenire subito? Con quali tempi e quale documentazione?
- Il numero di file va ancora accertato.
- Non sono più collegati a nessuna pratica, quindi non sono accessibili dall'applicazione.

**D6. Audit e cancellazione.**
Il registro delle operazioni non si modifica (è a garanzia di tutti). Va bene che, dopo la cancellazione di una persona, restino gli identificativi tecnici senza nome né email?

### E. Accessi, deleghe ed esportazioni — riguarda le fasi MF8 e MF9

**E1. Consulenti e reti.**
Il consulente (es. commercialista) accede ai dati dell'azienda con una delega a tempo concessa dall'azienda. Questo lo rende un autorizzato del titolare o un titolare autonomo? Cambia qualcosa nei contratti?
Stesso dubbio per le reti e le associazioni che ricevono deleghe nominative.

**E2. Statistiche aggregate per le reti.**
Le reti vedrebbero solo indicatori aggregati. Proponiamo una soglia minima di 5 aziende per valore, senza filtri liberi. È sufficiente perché i dati non siano più riferibili alle singole aziende o persone?

**E3. Esportazioni.**
Ogni esportazione viene registrata (chi, canale, perimetro, numero di righe, senza contenuto). È sufficiente come misura di responsabilizzazione? Serve altro, ad esempio un avviso al titolare?

**E4. Accesso eccezionale dell'amministratore tecnico.**
Abbiamo progettato un accesso eccezionale motivato, limitato, a tempo, approvato da un'altra persona, registrato e notificato all'organizzazione. È adeguato? Va previsto nel DPA?

### F. Account e sicurezza — riguarda le fasi MF6 e MF7

**F1. Verifica dell'identità.**
Il possesso di una casella email dimostra il controllo della casella, non l'identità legale. Per un amministratore di organizzazione basta l'attestazione di chi lo invita? Oppure serve una verifica più forte (es. SPID o CIE) per alcune operazioni?

**F2. Recupero dell'accesso dell'unico amministratore.**
Se l'unico amministratore perde l'accesso, prevediamo:
- una richiesta documentata del legale rappresentante, verificata fuori dalla piattaforma;
- l'esecuzione con doppio controllo.
È adeguato?

**F3. Violazioni dei dati.**
Come responsabile dobbiamo avvisare il titolare «senza ingiustificato ritardo» (art. 33.2). Va fissato un termine nel DPA, ad esempio 24 o 48 ore? Cosa deve contenere la procedura?

---

## 3. Materiale disponibile per il consulente

- Questo documento e il piano tecnico `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (§3.3 esportazioni, §3.5 cancellazione, §7 accesso eccezionale, §8 conservazione).
- `docs/DATA_RESIDENCY_AND_GDPR.md`: misure su dati inviati all'AI, log e storage.
- Elenco dei fornitori con le loro condizioni (da raccogliere dopo le risposte alla sezione A).

## 4. Cosa ci serve come risultato

1. Conferma o correzione dei ruoli (A1) e un modello di DPA (A2).
2. Elenco dei contratti e delle verifiche per ogni fornitore (A3), con indicazione sul fornitore AI da preferire tra OpenAI, Azure OpenAI in UE e Mistral AI.
3. Durate di conservazione approvate o corrette (sezione C), con la motivazione da riportare nell'informativa.
4. Indicazioni sulle regole di cancellazione (sezione D), così da approvare le regole R1–R13 del piano.
5. Indicazioni sulle informative e sulla necessità di una valutazione d'impatto (A5, A6).
