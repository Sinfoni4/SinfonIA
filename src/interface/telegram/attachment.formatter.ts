import type { DocumentOcrResult } from '../../ai/ocr/ocr.types.js';
import type { AttachmentRejectedError } from '../../core/errors/attachment.errors.js';

const DOCUMENT_LABELS: Record<DocumentOcrResult['documentType'], string> = {
  invoice: 'Fattura',
  delivery_note: 'Documento di trasporto (DDT)',
  receipt: 'Scontrino / ricevuta',
  certificate: 'Certificato',
  generic: 'Documento generico',
};

const FIELD_LABELS: Record<string, string> = {
  supplierName: 'fornitore',
  supplierVat: 'partita IVA',
  merchantName: 'esercente',
  merchantVat: 'partita IVA',
  documentDate: 'data',
  documentNumber: 'numero',
  taxableAmount: 'imponibile',
  vatRate: 'aliquota IVA',
  vatAmount: 'IVA',
  totalAmount: 'totale',
  recipientName: 'destinatario',
  title: 'titolo',
  issuer: 'ente emittente',
  holderName: 'intestatario',
  certificateNumber: 'numero certificato',
  issueDate: 'data di emissione',
  expiryDate: 'data di scadenza',
};

function euro(value: number | null | undefined): string | null {
  return typeof value === 'number' ? `${value.toFixed(2).replace('.', ',')} €` : null;
}

function summaryLines(result: DocumentOcrResult): Array<string | null> {
  switch (result.documentType) {
    case 'invoice':
      return [
        result.supplierName && `Fornitore: ${result.supplierName}`,
        result.documentNumber && `Numero: ${result.documentNumber}`,
        result.documentDate && `Data: ${result.documentDate}`,
        euro(result.totalAmount) && `Totale: ${euro(result.totalAmount)}`,
      ];
    case 'delivery_note':
      return [
        result.supplierName && `Mittente: ${result.supplierName}`,
        result.documentNumber && `Numero: ${result.documentNumber}`,
        result.documentDate && `Data: ${result.documentDate}`,
        result.items.length > 0 ? `Righe merce: ${result.items.length}` : null,
      ];
    case 'receipt':
      return [
        result.merchantName && `Esercente: ${result.merchantName}`,
        result.documentDate && `Data: ${result.documentDate}`,
        euro(result.totalAmount) && `Totale: ${euro(result.totalAmount)}`,
      ];
    case 'certificate':
      return [
        result.title && `Titolo: ${result.title}`,
        result.holderName && `Intestatario: ${result.holderName}`,
        result.expiryDate && `Scadenza: ${result.expiryDate}`,
      ];
    case 'generic':
      return [];
  }
}

export function formatAttachmentResult(
  ocrStatus: string,
  ocrResult: DocumentOcrResult | undefined,
): string {
  if (!ocrResult || ocrStatus === 'FAILED') {
    return '✅ Documento salvato sulla pratica.\n⚠️ Non è stato possibile leggerne il contenuto: verrà controllato manualmente.';
  }

  const lines = [
    '✅ Documento caricato sulla pratica.',
    `Tipo riconosciuto: ${DOCUMENT_LABELS[ocrResult.documentType]}`,
    ...summaryLines(ocrResult).filter((l): l is string => Boolean(l)),
  ];

  if (ocrResult.reviewRequired) {
    const missing = ocrResult.missingFields.map((f) => FIELD_LABELS[f] ?? f);
    lines.push(
      missing.length > 0
        ? `⚠️ Da verificare: non ho letto ${missing.join(', ')}.`
        : '⚠️ Alcuni dati vanno verificati manualmente.',
    );
  }
  return lines.join('\n');
}

export function formatAttachmentRejection(err: AttachmentRejectedError): string {
  switch (err.code) {
    case 'ATTACHMENT_TOO_LARGE':
      return '⚠️ Il file è troppo grande. Invia un documento più leggero (ad esempio una foto o un PDF di poche pagine).';
    case 'UNSUPPORTED_MEDIA_TYPE':
      return '⚠️ Formato non supportato. Puoi inviare foto (JPEG, PNG, WEBP) o documenti PDF.';
    case 'EMPTY_ATTACHMENT':
      return '⚠️ Il file ricevuto è vuoto.';
  }
}
