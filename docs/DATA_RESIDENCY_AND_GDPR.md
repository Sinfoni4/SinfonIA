# SinfonIA — Data Residency, GDPR & AI Security Architecture

Questo documento descrive l'architettura di sicurezza, la gestione della data residency e la conformità al **Regolamento Generale sulla Protezione dei Dati (GDPR - Regolamento UE 2016/679)** per il modulo di Intelligenza Artificiale e Trattamento Dati di **SinfonIA**.

---

## 1. Principi Architetturali di Protezione dei Dati

### 1.1 Privacy by Design & Minimizzazione (Art. 5 e 25 GDPR)
SinfonIA adotta il principio di minimizzazione dei dati prima di qualsiasi interazione con i Large Language Model (LLM) di terze parti:
1. **Pre-LLM Masking dei Dati Personali Identificativi (PII)**:
   Prima che il prompt venga costruito e inviato alle API esterne, il motore `PIIMinimizer` (`src/ai/security/pii-minimizer.ts`) scansiona l'input utente e sostituisce i dati sensibili con identificatori sintetici indicizzati:
   - **Codice Fiscale italiano**: sostituito con token tipo `[CODICE_FISCALE_1]`.
   - **IBAN italiano ed europeo**: sostituito con `[IBAN_1]`.
   - **Numeri di Carte di Credito**: sostituiti con `[CARD_NUMBER_1]`.
   - **Indirizzi Email**: sostituiti con `[EMAIL_1]`.
   - **Numeri di Telefono / Cellulari**: sostituiti con `[PHONE_1]`.

   > **Nomi e cognomi (aggiornato il 29/10/2026)**: i nomi indicati nell'input (es. "crea pratica per Mario Rossi") e i nomi delle pratiche inclusi nel contesto del prompt vengono sostituiti con segnaposto coerenti (`[NOME_1]`…) da `src/ai/security/name-pseudonymizer.ts` e ripristinati localmente nella risposta. Il riconoscimento è euristico (sequenze in maiuscolo, parole dopo «pratica per/di», nomi delle pratiche note): un nome scritto in forme insolite può ancora sfuggire, quindi resta consigliato un DPA con il provider. Prima: i nomi arrivavano al provider in chiaro.
2. **Ripristino Bidirezionale Locale (Unmasking)**:
   La corrispondenza tra token sintetico e dato reale (`piiMap`) è mantenuta **esclusivamente in memoria locale volatile** nel processo dell'applicazione. Una volta ricevuta la risposta strutturata dal provider LLM, il servizio SinfonIA ripristina i valori originali per consentire la corretta esecuzione aziendale: per le categorie mascherate sopra elencate il fornitore AI non riceve il valore in chiaro.
3. **Redazione nei Log Persistenti**:
   I log applicativi generati tramite Pino (`src/shared/logger.ts`) includono regole di redazione automatica (`[REDACTED]`) per intestazioni di autenticazione, token JWT, password, email, numeri di telefono e payload testuali.

---

## 2. Difesa da Prompt Injection & Delimitazione Dati

### 2.1 Delimitazione Semantica Rigida (`<user_input>`)
I dati inviati dall'utente vengono trattati tassativamente come **dati passivi** e mai come istruzioni di sistema:
- L'input dell'utente viene incapsulato all'interno del tag delimitatore semantico:
  ```xml
  <user_input>
  ... dati passivi dell'utente ...
  </user_input>
  ```
- **Escaping Difensivo**: Qualsiasi tentativo dell'utente di inserire tag di chiusura (es. `</user_input>`, `<system>`, `<|im_start|>`, `<<SYS>>`) viene neutralizzato e convertito in entità sicure (`&lt;/user_input&gt;`), impedendo l'uscita arbitraria dalla sandbox dei dati.

### 2.2 Neutralizzazione Pre-Execution di Jailbreak e Override
Il modulo `PromptGuard` (`src/ai/security/prompt-guard.ts`) esegue una scansione preliminare per intercettare i principali vettori di attacco noti:
- **Jailbreak / System Override**: tentativi di istruire il modello a ignorare le regole precedenti ("*ignore previous instructions*", "*DAN mode*", "*developer mode*").
- **Command & SQL Injection**: comandi distruttivi ("*drop database*", "*delete from users*", "*exec shell*").
- **Cross-Tenant Exfiltration**: tentativi di accedere a pratiche o dati di altri tenant ("*dump all tenants*", "*show all practices*").
- **Impersonation**: iniezione di tag di ruolo artificiali (`role: system`, `system:`).

Quando un pattern malevolo viene rilevato:
1. L'esecuzione verso il provider LLM viene **bloccata preventivamente** (risparmiando token ed evitando abusi).
2. Viene restituita una risposta sicura `clarification_required` con codice `SECURITY_INJECTION_BLOCKED`.
3. L'evento viene registrato nell'`AITracer` con esito `SECURITY_REJECTED`.
4. Viene garantita **totale assenza di mutazioni di stato** sul database.

**Limite**: il rilevamento si basa su un insieme ristretto di pattern regex, prevalentemente in inglese, e non intercetta parafrasi, testo in italiano o codifiche alternative. Va considerato una difesa aggiuntiva rispetto alla delimitazione dei dati e alla validazione deterministica nel Core, non una garanzia.

---

## 3. Data Residency & Provider Compliance

### 3.1 Localizzazione Geografica dei Dati (Data Residency UE)
Per conformità alle normative europee sul trasferimento internazionale dei dati (Capo V GDPR):
- **Stato attuale dell'implementazione (29/10/2026)**: `LLM_PROVIDER=openai` (default, endpoint pubblico `https://api.openai.com`) oppure `LLM_PROVIDER=azure` con `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` e `AZURE_OPENAI_DEPLOYMENT`: con una risorsa Azure OpenAI in una regione UE i prompt restano nello Spazio Economico Europeo; oppure `LLM_PROVIDER=mistral` con `MISTRAL_API_KEY` (e `MISTRAL_MODEL`, predefinito `mistral-small-latest`), endpoint `https://api.mistral.ai`.
- **Provider API Target**:
  - **Azure OpenAI Service**: distribuzione configurabile su regioni europee (es. *West Europe - Netherlands*, *North Europe - Ireland*, *Switzerland North*). I dati rimangono all'interno dei confini dello Spazio Economico Europeo (SEE).
  - **Mistral AI (La Plateforme)**: società francese; secondo fonti di terzi le richieste sono elaborate nell'UE per impostazione predefinita, i dati delle API non sono usati per l'addestramento e il DPA pubblicato include le clausole contrattuali standard. **Da verificare sul DPA ufficiale**: durata di conservazione delle richieste (citati 30 giorni per il controllo degli abusi), disponibilità della conservazione zero, eventuali trasferimenti temporanei fuori UE. La qualità sull'italiano va misurata con `npm run ai:eval:nightly` prima di adottarlo.
  - **OpenAI Enterprise / Zero Data Retention (ZDR)**: per impostazione predefinita con le API a pagamento, OpenAI non utilizza i dati inviati tramite API per addestrare i propri modelli (`data-sharing: false`) e supporta la cancellazione automatica della cronologia temporanea.
- **Isolamento Documentale su Storage Locale**:
  - Gli allegati caricati dai soci (foto di fatture, DDT, ricevute) risiedono, a scelta, sul filesystem locale in directory separate per tenant oppure su storage S3/MinIO con prefissi per tenant (`src/data/storage/`); in entrambi i casi l'accesso è confinato al tenant e protetto da controlli anti *path traversal*. Con S3 la regione predefinita è `eu-south-1` (Milano) ed è disponibile la cifratura lato server; con MinIO self-hosted i dati restano sull'infrastruttura scelta dal titolare.
  - Nessun documento o file binario viene trasferito a server terzi: l'OCR (Tesseract) e la lettura dei PDF avvengono in-process, con il modello linguistico italiano incluso nelle dipendenze e senza download a runtime. Un eventuale futuro motore OCR cloud dovrà rispettare gli stessi vincoli di residenza nell'UE.

---

## 4. Matrice di Sicurezza & Rischi

| Vettore di Attacco | Contromisura SinfonIA | Risultato di Sicurezza |
| :--- | :--- | :--- |
| **Prompt Injection Diretto** | Delimitazione `<user_input>` + Direttive di isolamento | L'input viene trattato solo come dato testuale inerte |
| **Jailbreak (DAN / Developer Mode)** | `PromptGuard` pattern scanner | Blocco preventivo dei pattern noti, esito `SECURITY_REJECTED`, zero mutazioni |
| **Tentativo Evasione Delimitatore** | `escapePromptData` (escaping `</user_input>`) | Impossibilità di evadere dal blocco dati utente |
| **Estrazione Cross-Tenant** | Scoping tenant obbligatorio su DB + filtro contesto | I dati di altri tenant non sono fisicamente presenti nel contesto |
| **Fuga di PII / Dati Personali** | Mascheramento sintetico pre-egress `maskPII` | CF, IBAN, carte, email, telefoni e nomi arrivano al provider come token (nomi riconosciuti in modo euristico) |
| **Manomissione Output AI** | Validazione post-generazione Zod `schemaVersion: 1` | Output non conforme rigettato o riparato deterministicamente |
