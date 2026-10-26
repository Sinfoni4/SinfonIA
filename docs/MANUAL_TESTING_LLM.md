# Manual testing con LLM reale

Dopo aver configurato un provider reale (OpenAI), usa questi casi per verificare che il prodotto funzioni con input umani.

## Setup

1. `.env`: imposta `ENABLE_LLM=true` e `OPENAI_API_KEY=sk-...`.
2. Avvia: `npm run dev`.
3. Usa `curl` o un client HTTP con header `x-tenant-id` (UUID del tenant) e opzionale `x-user-id`.

## Casi da provare

### 1. Input chiaro con UUID e stato

- **Input**: "Valida la pratica 550e8400-e29b-41d4-a716-446655440000"
- **Atteso**: 200, `success: true`, `result` con la practice aggiornata a VALIDATED (se la practice esiste per quel tenant).

### 2. Input ambiguo (nessun UUID)

- **Input**: "Porta la pratica a validato" (senza identificativo)
- **Atteso**: 400 con `INTERPRETER_ERROR` o 200 con `success: false` e messaggio di ambiguità, a seconda di come il modello risponde.

### 3. Comando non riconducibile a un’azione

- **Input**: "Quanto fa 2+2?" oppure "Raccontami una barzelletta"
- **Atteso**: risposta che indica ambiguità o errore, non esecuzione di transizione.

### 4. UUID malformato o stato inesistente

- **Input**: "Porta la pratica 123 a SUPER"
- **Atteso**: 400/422 (validazione) o 200 con `success: false` (executor/workflow).

### 5. Casi limite

- Input molto lungo (vicino al limite dell’endpoint).
- Input con caratteri speciali o emoji.
- Input in dialetto o con refusi ("pratica 550e8400 valida"): verificare che il modello estragga UUID e stato quando possibile.

## Cosa controllare

- **Errori**: messaggi chiari, nessuno stack trace esposto, codice errore coerente.
- **Ambiguità**: quando l’intento non è chiaro, il sistema non deve eseguire azioni (es. non deve inventare un practiceId).
- **Stabilità**: timeout e retry del provider; nessun crash su risposta malformata (parsing con fallback e validazione Zod).
- **Log**: in development, log di debug con l’output raw del LLM per analisi post-test.

## Esempio curl

```bash
# Sostituisci TENANT_UUID e (opzionale) USER_UUID con valori reali dal DB.
curl -s -X POST http://localhost:3000/ai/execute \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: TENANT_UUID" \
  -H "x-user-id: USER_UUID" \
  -d '{"input":"Valida la pratica 550e8400-e29b-41d4-a716-446655440000"}'
```
