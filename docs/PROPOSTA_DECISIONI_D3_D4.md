# SinfonIA — Proposta per le decisioni D3 e D4

**Stato**: proposta da approvare · **Data**: 04/11/2026 · **Riferimenti**: `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` §1.3 e §2.4, `docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md` §4.6 (pilota TerreFVG)

Le due decisioni sbloccano l'ondata **B5** (MF8 deleghe, MF9 reti e aggregati, pagine FE9), necessaria al pilota con la rete d'imprese agricole **TerreFVG**. Quanto già confermato resta valido: una delega a un'organizzazione vale solo per i **beneficiari nominativi approvati** dall'azienda che concede; la rete, senza delega, vede solo l'anagrafica minima delle aderenti e statistiche aggregate.

---

## D3 — Durata delle deleghe

Una delega permette a una persona (es. un consulente) o a una persona nominata della rete di lavorare sui dati di un'azienda, solo per le operazioni scelte.

| #    | Proposta                                                                                                           | Alternativa                                                             |
| :--- | :----------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| D3.1 | **Scadenza obbligatoria**, massimo **12 mesi** dalla concessione                                                   | 6 mesi (più prudente, più rinnovi) oppure 24 mesi                       |
| D3.2 | Durata proposta di default: **12 mesi**; l'azienda può sceglierne una più breve (1, 3, 6 mesi o una data)          | —                                                                       |
| D3.3 | **Rinnovo esplicito** da parte di un amministratore dell'azienda, per altri 12 mesi al massimo; **mai automatico** | rinnovo tacito (sconsigliato: l'accesso continuerebbe senza una scelta) |
| D3.4 | **Avvisi** all'azienda **30 e 7 giorni** prima della scadenza (chat ed email), con l'elenco dei beneficiari        | solo 7 giorni                                                           |
| D3.5 | Alla scadenza l'accesso cessa subito; la delega resta nello storico come «scaduta»                                 | —                                                                       |
| D3.6 | Revoca possibile in ogni momento dall'azienda, con effetto immediato                                               | —                                                                       |
| D3.7 | Le **operazioni sensibili** (`DELETE`, `EXPORT`) hanno un massimo più breve: **3 mesi**                            | stesso massimo delle altre                                              |

**Per il pilota**: la segreteria di TerreFVG che gestisce pratiche per conto delle aziende riceve deleghe di 12 mesi su lettura, creazione e aggiornamento; export e cancellazione solo se l'azienda li concede espressamente, per 3 mesi.

---

## D4 — Statistiche aggregate per le reti

Cosa vede la rete (TerreFVG) dell'insieme delle aziende aderenti, **senza** poter risalire alla singola azienda.

### Regole di protezione

| #    | Proposta                                                                                                                                                                     | Alternativa                                 |
| :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------ |
| D4.1 | Ogni valore è calcolato su **almeno 5 aziende** aderenti; sotto soglia si mostra «non disponibile»                                                                           | 3 aziende (più dati, più rischio) oppure 10 |
| D4.2 | I **conteggi piccoli** (1 o 2 aziende) si mostrano come «meno di 3»                                                                                                          | nessuna protezione dei conteggi piccoli     |
| D4.3 | **Periodi fissi** (mese, trimestre, anno solare) e **categorie fisse**: nessun filtro libero, per evitare che il confronto tra due interrogazioni riveli una singola azienda | —                                           |
| D4.4 | Calcolo solo sul server; al browser arrivano solo i valori finali                                                                                                            | —                                           |
| D4.5 | Un'azienda che si ritira dalla rete esce dagli aggregati dal periodo successivo                                                                                              | —                                           |
| D4.6 | Ogni consultazione delle statistiche è registrata nel registro attività della rete                                                                                           | —                                           |

### Elenco chiuso degli indicatori

| #   | Indicatore                                                                                                                                                                   | Perché serve alla rete                                                                |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| I1  | Aziende aderenti attive (numero e anagrafica minima: nome, comune, settore)                                                                                                  | sapere chi fa parte della rete; non è un dato aggregato e resta sempre visibile       |
| I2  | Pratiche aperte e completate nel periodo, per stato e per tipo                                                                                                               | carico di lavoro e servizi più usati                                                  |
| I3  | Tempo medio di completamento delle pratiche, per tipo                                                                                                                        | qualità del servizio                                                                  |
| I4  | Scadenze per categoria (DURC, sicurezza, visite mediche, patentini, certificazione biologica): aziende con almeno una scadenza **scaduta** e **in scadenza entro 30 giorni** | individuare dove serve un intervento collettivo (es. un corso di sicurezza per tutti) |
| I5  | Aziende con **certificazione biologica valida** sul totale                                                                                                                   | indicatore tipico di una rete agricola come TerreFVG                                  |
| I6  | Documenti caricati nel periodo e quota letta automaticamente senza verifica                                                                                                  | efficacia della digitalizzazione                                                      |
| I7  | Uso dei canali: richieste arrivate da chat e da dashboard                                                                                                                    | adozione degli strumenti                                                              |

Indicatori futuri (es. quaderno di campagna, carburante agevolato) si aggiungono all'elenco solo con una nuova approvazione, dopo la definizione del modulo agricolo (B1) con TerreFVG.

---

## Cosa approvare

1. **D3**: punti D3.1–D3.7 come proposti, oppure le alternative indicate.
2. **D4**: regole D4.1–D4.6 e indicatori I1–I7 come proposti, oppure con modifiche.

Dopo l'approvazione i valori vengono riportati in `docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md` (§1.3, §2.4, §A) e si può avviare B5.
