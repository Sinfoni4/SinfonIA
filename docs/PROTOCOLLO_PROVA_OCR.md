# SinfonIA — Protocollo di prova OCR su documenti reali

**Scopo**: misurare quanto l'OCR di SinfonIA legge correttamente documenti veri (foto da smartphone e PDF) prima del pilota, e decidere se basta il motore locale attuale o serve un motore più potente.

**Perché serve**: i test automatici usano 7 documenti fittizi generati al computer, puliti e leggibili. Su quelli l'OCR è al 100%, ma le foto reali hanno luce irregolare, pieghe, ombre, timbri, layout diversi da fornitore a fornitore.

---

## 1. Campione da raccogliere

Almeno **40 documenti**, il più possibile vari (fornitori, layout, qualità della foto):

| Tipo | Quantità | Note |
| :--- | :---: | :--- |
| Fatture fornitore | 15 | Metà foto da smartphone, metà PDF (digitali e scansionati) |
| DDT / bolle di consegna | 10 | Preferibilmente foto, anche con timbri o firme |
| Scontrini / documenti commerciali | 10 | Foto, inclusi scontrini termici sbiaditi o arrotolati |
| Certificati (BIO, DURC, sicurezza, visite mediche) | 5 | PDF o foto |

Le foto vanno scattate **come le scatterebbe un socio**: con il telefono, senza scanner, in condizioni normali. Non serve che siano perfette: interessa proprio il caso reale.

## 2. Dati personali e conservazione

- Usare documenti **aziendali** di soci che hanno dato il consenso, oppure documenti della cooperativa stessa.
- **Oscurare** prima dello scatto o sul file i dati di persone fisiche non necessari (nomi di clienti privati, indirizzi di abitazione, codici fiscali di persone). P.IVA, numeri, date e importi devono restare leggibili: sono ciò che si misura.
- Conservare i file **solo** nella cartella `ocr-samples/` dentro il progetto (esclusa da Git tramite `.gitignore`) o in una cartella fuori dal repository. **Non committarli e non caricarli su servizi esterni.**
- L'OCR gira interamente in locale: durante la prova nessun documento esce dal computer.
- A prova conclusa, cancellare la cartella o conservarla secondo le regole interne della cooperativa.

## 3. Preparare i valori attesi

Per ogni file (es. `fattura-01.jpg`) creare accanto un file `fattura-01.expected.json` con il tipo di documento e i valori **letti a occhio** sul documento:

```json
{
  "documentType": "invoice",
  "fields": {
    "supplierVat": "IT01234567897",
    "documentNumber": "2026/118",
    "documentDate": "2026-10-15",
    "taxableAmount": 1250.5,
    "vatAmount": 275.11,
    "totalAmount": 1525.61
  }
}
```

Regole:
- Date nel formato `AAAA-MM-GG`; importi come numeri con il punto decimale (`1525.61`, non `"1.525,61 €"`).
- Indicare solo i campi presenti sul documento; un campo assente non va inserito.
- Campi per tipo:

| `documentType` | Campi da verificare |
| :--- | :--- |
| `invoice` | `supplierName`, `supplierVat`, `documentNumber`, `documentDate`, `taxableAmount`, `vatAmount`, `totalAmount` |
| `delivery_note` | `supplierName`, `supplierVat`, `documentNumber`, `documentDate`, `recipientName` |
| `receipt` | `merchantName`, `merchantVat`, `documentDate`, `totalAmount` |
| `certificate` | `category` (`BIO`, `DURC`, `SICUREZZA_LAVORO`, `VISITA_MEDICA`, `PATENTINO`, `ALTRO`), `holderName`, `certificateNumber`, `issueDate`, `expiryDate` |

Esempi completi: `tests/fixtures/ocr/*.expected.json`.

## 4. Eseguire la prova

```bash
npm run ocr:accuracy -- --dir ocr-samples --out ocr-samples/report.json
```

Lo script stampa per ogni documento i campi letti male e un riepilogo:

- **Tipo documento corretto**: quante volte il documento è stato riconosciuto (fattura, DDT, ...).
- **Campi corretti**: percentuale di campi letti esattamente.
- **Errori senza revisione**: campi **sbagliati** consegnati **senza** che il sistema chiedesse una verifica umana. È l'indicatore più importante, perché un dato sbagliato marcato "da verificare" viene controllato, uno sbagliato e silenzioso no.
- **Marcati da verificare**, confidenza OCR media, tempo medio.

`report.json` contiene il dettaglio da analizzare (contiene dati dei documenti: trattarlo come i documenti stessi).

## 5. Criteri di accettazione per il pilota

| Indicatore | Soglia |
| :--- | :---: |
| Tipo documento corretto | ≥ 95% |
| Totale, data, numero documento, P.IVA (ciascuno) | ≥ 90% |
| Errori senza revisione | ≤ 2% dei campi |
| Tempo medio per documento | ≤ 5 s |

## 6. Decisioni in base al risultato

- **Soglie rispettate** → si procede al pilota con il motore locale.
- **Errori soprattutto su layout o parole chiave** (es. "Tot. fattura", "N° doc.") → si estendono le regole di lettura usando i casi falliti come nuovi test: intervento rapido, di solito ore.
- **Errori dovuti alla qualità del testo letto** (confidenza bassa, caratteri sbagliati) → si valuta un pre-trattamento delle immagini (raddrizzamento, contrasto) oppure un motore OCR cloud con dati in UE, da aggiungere tramite l'interfaccia `OcrEngine` già prevista. Il motore cloud richiede DPA con il fornitore e aggiornamento del documento GDPR.
- **Troppi "errori senza revisione"** → si alzano le soglie che attivano `reviewRequired` prima di qualsiasi altro intervento.

## 7. Chi fa cosa

| Attività | Chi |
| :--- | :--- |
| Raccolta e oscuramento dei documenti, consenso dei soci | Cooperativa / referente del pilota |
| Compilazione dei file `.expected.json` | Referente amministrativo (conosce i documenti) |
| Esecuzione dello script e analisi dei risultati | Sviluppo |
| Decisione sul motore OCR (§6) | Sviluppo + referente del progetto |
