# SinfonIA — Frontend e interfaccia utente, prima versione

**Stato**: proposta da approvare · **Data**: 30/10/2026 · **Versione**: 1
**Riferimenti**: `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (permessi §3, login §4.1–4.2, revoca §5), `docs/CRONOPROGRAMMA_EVOLUTIVO.md` (Fase 5)

Questo documento imposta la prima dashboard web di SinfonIA prima di scrivere codice. Descrive:

- chi la usa e quali pagine ha;
- quali API usa (già pronte o da aggiungere);
- la tecnologia, la sicurezza nel browser e le tappe di sviluppo.

Le scelte segnate **F1–F7** (§9) sono decisioni del proprietario: nessuna dipendenza viene installata prima dell'approvazione.

---

## 1. Obiettivo e perimetro

La chat (Telegram, WhatsApp) resta il canale principale per le persone sul campo. La dashboard serve dove la chat è scomoda:

- elenchi lunghi con filtri;
- dettaglio di una pratica con allegati e dati letti dai documenti;
- gestione delle persone (inviti, ruoli, revoche);
- esportazioni.

**Prima versione (proposta, F1)**: per **amministratori e operatori di un'azienda**. Un collaboratore (MEMBER) può accedere, ma vede solo le proprie pratiche e scadenze, come già oggi nelle API.

**Fuori dalla prima versione**:

| Funzione                                        | Motivo                                                                 |
| :---------------------------------------------- | :--------------------------------------------------------------------- |
| Dashboard di rete o consorzio (Fase 5)          | dipende dagli aggregati delle reti (D4, rinviata) e dalle deleghe (D3) |
| Deleghe e consulenti                            | MF8, in attesa di D3                                                   |
| Cancellazione di pratiche                       | regole C3/R1–R13 in attesa della consulenza legale                     |
| Assistente AI nel browser                       | la chat esiste già; si valuta dopo                                     |
| Accesso eccezionale dell'amministratore tecnico | progettato (§7 del piano), non da implementare ora                     |

---

## 2. Pagine

|  #  | Pagina              | Chi                          | Contenuto e azioni                                                                                                                                        |
| :-: | :------------------ | :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Accesso             | tutti                        | email, poi codice di 6 cifre; messaggio identico per email esistenti e non                                                                                |
| P2  | Scelta dell'azienda | chi ha più appartenenze      | elenco aziende con ruolo; scelta ricordata nella sessione; cambio dall'intestazione                                                                       |
| P3  | Pratiche            | tutti                        | elenco paginato con ricerca e filtro per stato; ordinamento; ADMIN e OPERATOR vedono l'azienda, MEMBER le proprie                                         |
| P4  | Dettaglio pratica   | tutti, nel proprio perimetro | stato e date; passaggi di stato consentiti (ADMIN, OPERATOR); allegati con caricamento, download e dati letti (fattura, DDT, ricevuta)                    |
| P5  | Nuova pratica       | tutti                        | nome della pratica                                                                                                                                        |
| P6  | Scadenze            | tutti, nel proprio perimetro | elenco con giorni mancanti; nuova scadenza e chiusura (ADMIN, OPERATOR)                                                                                   |
| P7  | Export              | tutti, nel proprio perimetro | periodo (oggi, mese, anno, tutto), poi download del CSV; registrato nell'audit                                                                            |
| P8  | Persone             | ADMIN                        | membri con ruolo e stato; invito per email; cambio di ruolo; revoca e riattivazione; permesso di export dell'azienda per gli OPERATOR; export pianificato |
| P9  | Accettazione invito | invitati                     | dal link nell'email: codice inviato alla stessa email, poi accesso                                                                                        |
| P10 | Profilo             | tutti                        | email, aziende, sessione; esci; esci da tutti i dispositivi                                                                                               |

Ogni pagina mostra solo le azioni consentite. Il permesso però resta deciso dal backend a ogni richiesta: il frontend **non è un confine di sicurezza** (decisione A.7 del piano). Un'azione rifiutata (403) o una sessione revocata (401) vengono gestite con un messaggio chiaro.

**Lingua**: italiano.
**Dispositivi**: computer e telefono. Un amministratore può usarla anche da mobile.
**Accessibilità**: contrasto, navigazione da tastiera, etichette dei campi.

---

## 3. API: già pronte

| Pagina | Rotte                                                                                                                                                                                |
| :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1, P9 | `POST /auth/login/start`, `/auth/login/verify`, `/auth/invitations/start`, `/auth/invitations/accept`                                                                                |
| P2     | organizzazioni restituite da `/auth/login/verify`; `POST /auth/token` con `orgId` (token di 10 minuti per l'azienda scelta)                                                          |
| P3–P5  | `GET /practices` (pagina, limite, stato, ricerca, ordinamento), `GET /practices/:id`, `POST /practices`, `POST /practices/:id/transition`                                            |
| P4     | `GET /practices/:id/attachments`, `POST /practices/:id/attachments` (multipart), `GET /practices/:id/attachments/:attachmentId/download`                                             |
| P6     | `GET /compliance/deadlines`, `POST /compliance/deadlines`, `POST /compliance/deadlines/:id/close`                                                                                    |
| P7     | `POST /practices/export`                                                                                                                                                             |
| P8     | `GET /members`, `POST /members/invitations`, `POST /members/invitations/:id/revoke`, `POST /members/:userId/role`, `…/revoke`, `…/reactivate`, `…/permissions`, `…/scheduled-export` |
| P10    | `GET /auth/whoami`, `POST /auth/logout`                                                                                                                                              |

---

## 4. API: da aggiungere nel backend (prerequisiti)

|  #  | Modifica                                                                                                                             | Perché                                                                                                     |
| :-: | :----------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| B1  | **Token di rinnovo in un cookie** `HttpOnly`, `Secure`, `SameSite=Strict`, con percorso `/auth`, invece che nel corpo della risposta | Così uno script nella pagina non può leggerlo; il token di accesso resta solo in memoria                   |
| B2  | **Stessa origine**: il backend serve anche la dashboard compilata (o un proxy davanti a entrambi)                                    | Niente CORS, il cookie funziona, criteri di sicurezza dei contenuti (CSP) semplici                         |
| B3  | `GET /members/invitations`                                                                                                           | La pagina P8 deve mostrare gli inviti in attesa e permettere di revocarli                                  |
| B4  | `POST /auth/logout-all`                                                                                                              | «Esci da tutti i dispositivi» (P10); esiste già la funzione di revoca globale (MF5)                        |
| B5  | **Codice di accesso visibile solo in sviluppo** (F5)                                                                                 | Con le email simulate, chi sviluppa deve poter entrare; mai in produzione (rifiutato dalla configurazione) |
| B6  | `GET /practices/:id` con gli stati successivi consentiti                                                                             | Mostrare solo i passaggi di stato validi, senza duplicare nel frontend la macchina a stati                 |
| B7  | Intestazioni di sicurezza per la dashboard (CSP stretta, nessuno script esterno)                                                     | Ridurre l'impatto di un eventuale XSS                                                                      |
| B8  | Canale `web` nell'audit delle richieste della dashboard (oggi `api`)                                                                 | Distinguere nei registri dashboard e integrazioni                                                          |

---

## 5. Tecnologia (F2, F3)

**Proposta**: applicazione a pagina singola in **React con TypeScript**, compilata con **Vite**. Il codice sta nella cartella `web/` dello stesso repository e la versione compilata è servita dal backend (B2).

- **Perché**: stesso linguaggio del backend (TypeScript), tipi condivisibili con le API, strumenti diffusi, pagine interattive (caricamento allegati, filtri) senza ricaricare.
- **Librerie proposte**, tutte da approvare:
  - React Router per le pagine;
  - TanStack Query per le chiamate e la cache;
  - una libreria di componenti accessibile, oppure CSS proprio (F3).
- **Alternativa**: pagine generate dal server con poche parti dinamiche (es. htmx).
  - Vantaggi: meno codice nel browser, nessuna compilazione separata.
  - Svantaggi: meno adatta a caricamenti con anteprima e filtri ricchi; tipi meno condivisi.
- **Test**: componenti con Vitest (già nel progetto); percorsi principali nel browser (accesso, pratiche, allegati, persone) con uno strumento di test end-to-end, da approvare.

---

## 6. Sicurezza nel browser

1. **Token di accesso** (10 minuti) solo in memoria.
2. **Token di rinnovo** nel cookie protetto (B1). Il rinnovo avviene in automatico prima della scadenza.
3. **Nessun dato personale** in `localStorage`, nell'indirizzo della pagina o nei log del browser. In `localStorage` vanno solo preferenze (es. ultima azienda scelta, come identificativo).
4. **Allegati** scaricati con la sessione e salvati come file, mai aperti nella pagina. Il backend li invia già come download (`no-store`, `nosniff`, `attachment`).
5. **Revoca**:
   - una risposta 401 porta all'accesso;
   - un 403 mostra «non hai il permesso»;
   - i dati in cache vengono svuotati all'uscita e al cambio di azienda.
6. **Cambio di azienda**: nuovo token per l'azienda scelta e cache azzerata, così i dati di due aziende non si mescolano.
7. **Contenuti**: nessun HTML scritto dagli utenti viene inserito nella pagina (nomi di pratiche, dati OCR mostrati come testo).

---

## 7. Dove pubblicarla (F4)

La dashboard segue l'hosting del backend (B2). È la decisione sull'hosting UE di produzione, ancora da prendere.

- **Sviluppo**: sul PC, con il server di sviluppo di Vite che inoltra le chiamate al backend.
- **Staging**: servita dallo staging sulla porta 3110.
- **Pilota**: sul server di produzione con HTTPS. **Non** sul PC.

---

## 8. Tappe

| Tappa | Contenuto                                                                                      | Stima (giorni) | Dipende da |
| :---: | :--------------------------------------------------------------------------------------------- | :------------: | :--------- |
|  FE0  | Prerequisiti backend B1–B8                                                                     |      2–3       | —          |
|  FE1  | Struttura `web/`, accesso (P1), scelta azienda (P2), profilo (P10), gestione sessione e revoca |       3        | FE0, F2    |
|  FE2  | Pratiche: elenco, dettaglio, nuova, passaggi di stato, allegati (P3–P5)                        |      4–5       | FE1        |
|  FE3  | Scadenze ed export (P6–P7)                                                                     |       2        | FE1        |
|  FE4  | Persone e inviti (P8–P9)                                                                       |       3        | FE1        |
|  FE5  | Test end-to-end, accessibilità, rifinitura mobile, pubblicazione sullo staging                 |      2–3       | FE2–FE4    |

**Totale stimato: 16–19 giorni di lavoro.** Le stime sono indicative.

L'uso reale da parte del pilota richiede anche:

- il fornitore email (D11), perché gli utenti ricevano i codici;
- l'hosting di produzione (F4).

---

## 9. Decisioni richieste

|  #  | Decisione                     | Proposta                                                                                                                                        |
| :-: | :---------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Utenti della prima versione   | amministratori e operatori di un'azienda; collaboratori in sola lettura del proprio perimetro                                                   |
| F2  | Tecnologia                    | React + TypeScript + Vite nella cartella `web/`, servita dal backend                                                                            |
| F3  | Componenti grafici            | una libreria accessibile e diffusa (da scegliere al momento, con licenza permissiva) oppure CSS proprio; da decidere con l'aspetto grafico (F6) |
| F4  | Hosting                       | legato alla scelta dell'hosting UE di produzione                                                                                                |
| F5  | Accesso in sviluppo           | codice mostrato solo con `NODE_ENV=development` e invio simulato; rifiutato altrove                                                             |
| F6  | Aspetto grafico               | colori e logo SinfonIA, se esistono; altrimenti una base neutra da personalizzare                                                               |
| F7  | Approvazione delle dipendenze | elenco esatto con versioni presentato all'avvio di FE1                                                                                          |

---

## 10. Come si collega al resto

- **Permessi**: la dashboard usa lo stesso servizio di autorizzazione della chat e delle API. Nessuna regola viene duplicata nel frontend, oltre a nascondere le azioni non consentite.
- **Vista**: la regola C2 (in chat la vista predefinita sono le proprie pratiche) riguarda la chat. Nella dashboard ADMIN e OPERATOR vedono l'azienda, con il filtro «solo mie» a portata di mano.
- **Export**: valgono le regole D5. Ogni export dalla dashboard è registrato con canale `web`, e un OPERATOR esporta l'azienda solo con il permesso concesso da un ADMIN.
- **Dati personali**: valgono le domande aperte per il consulente (`docs/CONSULENZA_LEGALE_PRIVACY_DOMANDE.md`), in particolare l'informativa per gli utenti della dashboard.
