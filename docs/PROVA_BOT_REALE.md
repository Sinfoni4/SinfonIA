# SinfonIA — Prova con il bot vero sullo staging

Lista da seguire sul telefono, con il bot Telegram vero collegato allo staging, per le verifiche ancora aperte (`docs/ELENCO_STEP_MANCANTI.md`, punti 67, 68 e 70). Ogni passo dice cosa fare e cosa ci si aspetta; segnare ✅ o ❌ e, per ogni ❌, annotare l'ora e il testo ricevuto (bastano una foto dello schermo e l'ora: il resto si trova nei log).

Tempo previsto: circa un'ora. Servono dati inventati: nessun documento o nome reale.

## 0. Preparazione

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 0.1 | Avviare il database (se il PC è stato riavviato) e lo staging: `npm run staging:start -- --dashboard-login` | «Applicazione: avvio sulla porta 3110…» | |
| 0.2 | Aprire `http://localhost:3110/app/` ed entrare come amministratore dell'organizzazione di prova | Home con gli indicatori | |
| 0.3 | In **Persone** avere tre persone invitate con un'email inventata: amministratore (A), operatore (O), socio (S). Per una quarta persona (P, solo chat) creare in **Persone → Invito con link Telegram** un link personale | Le tre persone in elenco; il link di P | |
| 0.4 | Usare due telefoni (o due account Telegram): uno per A o O, uno per S | — | |

Per la Mini App (sezione 9) serve lo staging pubblico con il tunnel: `npm run staging:start -- --public --public-url=https://<indirizzo>`, avviato dopo il tunnel (non insieme a `--dashboard-login`).

## 1. Collegamento della chat

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 1.1 | Dal telefono di S: aprire il bot e premere **Avvia** (`/start`) senza essere collegati | «Il tuo account non è ancora collegato…»: spiega `/accedi` | |
| 1.2 | `/accedi`, poi l'email di S, poi il codice (sullo staging le email sono simulate: il codice compare in chat) | «Bentornato! Lavori per …» con il nome dell'organizzazione e il menu | |
| 1.3 | Su un altro account Telegram: `/accedi` con l'email di S e codici sbagliati | Rifiuto chiaro, nessun collegamento; dopo troppi tentativi il blocco temporaneo | |
| 1.4 | Collegare anche A (o O) dall'altro telefono | Benvenuto con l'elenco per chi gestisce le pratiche (validare, completare, scadenze…) | |
| 1.5 | Dal telefono di P: aprire il link personale | P è collegato senza email, con il ruolo scelto nell'invito | |

## 2. Menu e aiuto (A2)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 2.1 | Toccare **❓ Aiuto** | L'elenco di cosa si può fare | |
| 2.2 | Toccare **📁 Le mie pratiche** | Elenco (o «nessuna pratica») | |
| 2.3 | Toccare **🏢 La mia azienda** | Scheda con nome e dati dell'azienda | |
| 2.4 | Scrivere con un errore di battitura: `scadense`, `documneti` | Il bot capisce o propone il comando giusto | |

## 3. Pratiche (A3)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 3.1 | Da S: `crea pratica per Mario Rossi` | «Pratica creata» con i pulsanti delle azioni | |
| 3.2 | Da S: toccare il pulsante di stato della pratica | Stato attuale | |
| 3.3 | Dalla dashboard (A): **Bacheca** → assegnare la pratica a O | S riceve in chat l'avviso dell'assegnazione (se previsto per il suo ruolo); O la vede tra le sue | |
| 3.4 | Da A in chat: `valida la pratica di Mario Rossi` | Richiesta di conferma, poi «Pratica validata»; S riceve l'avviso del cambio di stato | |
| 3.5 | Da A: `completa quella` | La stessa pratica passa a completata; avviso a S | |

## 4. Documenti in chat

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 4.1 | Da S: inviare la foto di una fattura **inventata** (stampata o a schermo) | Il bot chiede a quale pratica collegarla, poi «Documento caricato sulla pratica» | |
| 4.2 | Attendere qualche secondo | Messaggio con i dati letti (tipo, data, totale…) e i pulsanti per confermarli; avvisi in italiano se la lettura è incerta | |
| 4.3 | Confermare i dati | «Dati del documento confermati» | |
| 4.4 | Toccare **📎 I miei documenti** | Il documento appena caricato, con la sua pratica | |
| 4.5 | Inviare un file non ammesso (es. un `.zip`) | Rifiuto chiaro, nessun file salvato | |
| 4.6 | In dashboard: **Verifica** | Il documento compare tra quelli da verificare (se non confermato) | |

## 5. Richieste di documenti e promemoria

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 5.1 | In dashboard, nella pratica di S: chiedere un documento con scadenza **dopodomani** | S riceve in chat la richiesta | |
| 5.2 | Attendere il controllo successivo (sullo staging gira ogni 15 secondi; il promemoria parte una volta al giorno per richiesta) | S riceve il promemoria «tra due giorni» una sola volta | |
| 5.3 | Da S: inviare il documento richiesto | La richiesta risulta soddisfatta in dashboard (**Richieste**); nessun altro promemoria | |

## 6. Scadenze e promemoria (fase 3C)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 6.1 | Da A: `nuova scadenza durc <data tra 7 giorni> DURC annuale` | «Scadenza registrata» | |
| 6.2 | Toccare **⏰ Le mie scadenze** | La scadenza appena creata con i giorni mancanti | |
| 6.3 | Attendere il controllo | Promemoria a 7 giorni, una sola volta (le soglie sono 30, 15, 7, 1 giorni e il giorno stesso) | |
| 6.4 | Creare una scadenza con data di **oggi** | Promemoria «scade oggi» | |

## 7. Assistenza (A4)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 7.1 | Da S: toccare **🙋 Operatore** | Scelta dell'argomento (pratica, documento, scadenza, altro) | |
| 7.2 | Scegliere **📁 Una pratica** | Conferma che la richiesta è arrivata; A e O ricevono l'avviso | |
| 7.3 | Ripetere 7.1 | Il bot dice che c'è già una richiesta aperta (nessun doppione) | |
| 7.4 | In dashboard (**Assistenza**): **Prendi in carico** | S riceve l'avviso «presa in carico» | |
| 7.5 | **Chiudi** | S riceve l'avviso di chiusura | |

## 8. Console di piattaforma (punto 70)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 8.1 | `npm run platform:admin` per dare il ruolo di gestore a un account, poi entrare e scegliere **Console di piattaforma** | Elenco delle organizzazioni | |
| 8.2 | **Salute** | Database, coda dei messaggi, lettura documenti, spazio, ultimo backup | |
| 8.3 | **Consumi IA** e **Consumi** | Dati del mese; esportazione in CSV, Excel e PDF | |

## 9. Mini App (con lo staging pubblico)

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 9.1 | Da S: `/app` | Pulsante che apre la Mini App | |
| 9.2 | Aprirla | Pratiche, scadenze e documenti di S, senza nuovo accesso | |
| 9.3 | **Assistente** (solo se l'IA è attiva per l'organizzazione) | Risposte come in chat | |

## 10. Scollegamento

| # | Cosa fare | Atteso | Esito |
| :-: | :--- | :--- | :-: |
| 10.1 | Da S: `/scollega` e confermare | Conferma; i messaggi successivi chiedono di collegarsi di nuovo | |
| 10.2 | In dashboard, **Persone → S** | Il collegamento risulta revocato | |

## Dopo la prova

- Inviare l'elenco dei ❌ con ora e foto: ogni errore diventa un caso di test.
- Le pratiche e i documenti inventati possono restare sullo staging: non contengono dati reali.
