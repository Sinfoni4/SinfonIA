# SinfonIA — Fase 0: rischi sul PC di sviluppo (S07) e fornitore IA effettivo (S08)

**Data delle verifiche**: 05/11/2026 · **Metodo**: sola lettura (stato della cifratura letto da Windows, nomi delle impostazioni senza valori, conteggi sul database dello staging in una transazione di sola lettura) · **Stato**: inventario e piano di protezione **da approvare**; nessuna modifica al PC è stata fatta.

---

## S07 — Che cosa c'è sul PC e con quale rischio

| Elemento | Dove | Fatto verificato | Rischio |
| :--- | :--- | :--- | :--- |
| Cifratura del disco di sistema | C: | BitLocker **disattivato** (codice di protezione 2) | Con il PC perso o rubato, chi lo apre legge database, documenti e segreti |
| Cifratura della chiavetta dei backup | E: (PENNA USB) | BitLocker **disattivato**; i 5 backup sono però **cifrati da SinfonIA** (AES-256-GCM) | Basso per i backup in sé; vedi la riga della chiave |
| Chiave dei backup | `.env` (`BACKUP_KEY`) sul disco C: non cifrato | Presente | **Alto**: PC e chiavetta insieme danno accesso ai backup; serve una seconda copia della chiave tenuta altrove e mai sul PC in chiaro |
| Segreti dell'applicazione | `.env`: 16 impostazioni, tra cui token del bot Telegram, chiave OpenAI, segreto dei token di accesso, password dei tre ruoli del database | Esclusi da Git (`.gitignore`, righe 3–4) e mai entrati nella cronologia | Medio: in chiaro su disco non cifrato |
| Database dello staging e dei test | `.runtime/pgdata_test` (circa 177 MB), stesso server PostgreSQL per staging e test | Escluso da Git | Medio: dati dello staging su disco non cifrato; un errore sui test può toccare il server dello staging |
| Allegati dello staging | `.runtime/storage-staging` (circa 9 MB) | Escluso da Git | Medio |
| Documenti reali per le prove di lettura | `ocr-samples/` (7 file) | Escluso da Git | **Alto** se contengono dati personali di terzi |
| Registri dello staging | uscita della finestra in cui gira; i campi sensibili sono oscurati (`src/shared/logger.ts`) | Nessun archivio permanente | Basso |
| Accesso dalla rete | con il login a codice, lo staging accetta connessioni solo da 127.0.0.1 | Verificato | Basso |

### Piano di protezione proposto (da approvare)

1. **BitLocker su C:**, e anche su E: se la chiavetta resta il supporto dei backup. È un cambio di configurazione del PC: lo fa il proprietario, o lo autorizza esplicitamente.
2. **Seconda copia della `BACKUP_KEY`** fuori dal PC e dalla chiavetta, per esempio in un gestore di password o su carta in cassaforte. Senza la chiave i backup non si ripristinano.
3. **Documenti reali in `ocr-samples/`**: usarli solo per la misura della lettura (Q07), poi cancellarli o tenerli in un'area cifrata.
4. **Nessun dato reale del pilota sul PC**: i dati reali vanno solo nell'ambiente di produzione (fase 2).
5. **Database dei test separato da quello dello staging** (fase 2, con la produzione).
6. **Segreti della produzione in un gestore dei segreti**, mai copiati nel `.env` del PC (fase 2, I06).

---

## S08 — Fornitore IA usato davvero

| Domanda | Risposta | Evidenza |
| :--- | :--- | :--- |
| L'IA è accesa sullo staging? | **Sì** | `ENABLE_LLM` attivo in `.env` |
| Con quale fornitore? | **OpenAI** (USA): `LLM_PROVIDER` non è impostato, quindi vale il predefinito `openai`; è presente solo la chiave OpenAI | `src/config/config.ts:33`; nomi delle impostazioni in `.env` |
| Con quale modello? | `gpt-4o-mini`, il predefinito: `OPENAI_MODEL` non è impostato | `src/config/config.ts:31` |
| Che cosa riceve il fornitore? | I messaggi liberi della chat (non i comandi riconosciuti, che non passano dall'IA), con codici fiscali, IBAN, carte, email e telefoni mascherati e i nomi sostituiti in modo euristico | `src/ai/security/` |
| Quante richieste sono state fatte finora? | **Non ricostruibile da SinfonIA**: il database dello staging non ha nessuna traccia dell'IA, perché le chiamate fatte dalla chat **non venivano registrate** (solo quelle dell'API `/ai`) | 0 righe in `ai_trace` sullo staging; `src/index.ts` prima di questa fase |
| È corretto ora? | **Sì, con questa fase**: anche le chiamate dalla chat lasciano una traccia (fornitore, modello, token, tempi, esito; mai il testo), visibile nella console «Consumi IA» | `src/interface/telegram/telegram.adapter.ts`; test in `tests/chat.clarification.test.ts` |
| C'è un contratto sul trattamento dei dati con OpenAI? | Non risulta | — |

**Da fare da parte del proprietario**:

- Controllare nella console di OpenAI (sezione «Usage») quante richieste sono state fatte dallo staging: è l'unica fonte per il passato.
- Prima di qualsiasi dato reale, scegliere tra:
  - **Mistral**: ha un contratto sul trattamento dei dati per i clienti commerciali (Data Processing Addendum, in vigore dal 27/07/2026, [legal.mistral.ai](https://legal.mistral.ai/terms/data-processing-addendum)); la regione di elaborazione va verificata sul suo Trust Center. Si attiva con `LLM_PROVIDER=mistral` e una chiave `MISTRAL_API_KEY` creata dal proprietario.
  - **IA spenta** (`ENABLE_LLM=false`): la chat funziona con i comandi riconosciuti (pratiche, scadenze, documenti, assistenza); i messaggi liberi non vengono interpretati. Il testo esatto della risposta in questo caso va provato sul bot prima del pilota.
