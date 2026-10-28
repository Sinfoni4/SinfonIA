/**
 * Generates the OCR test fixtures in tests/fixtures/ocr/.
 *
 * Every document is fictitious (made-up companies, VAT numbers and amounts).
 * The output is committed so tests never depend on system fonts or on this script:
 * re-run it only when the fixtures must change.
 *
 *   npx tsx scripts/generate-ocr-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const OUT_DIR = path.resolve(process.cwd(), 'tests', 'fixtures', 'ocr');

const INVOICE_LINES = [
  'AGRICOLA ESEMPIO S.R.L.',
  'Via dei Campi 12 - 33100 Udine (UD)',
  'P.IVA IT01234567897',
  '',
  'FATTURA N. 2026/118',
  'Data: 15/10/2026',
  'Cliente: Cooperativa Demo Soc. Coop.',
  '',
  'Mele Golden kg 500 x 1,50 = 750,00',
  'Pere Williams kg 250 x 2,00 = 500,50',
  '',
  'Imponibile: 1.250,50',
  'IVA 22%: 275,11',
  'Totale documento: 1.525,61',
];

const DDT_LINES = [
  'DOCUMENTO DI TRASPORTO',
  'DDT N. 2026-088',
  'Data: 20/10/2026',
  'Mittente: Cantina Esempio S.r.l.',
  'P.IVA 09876543217',
  'Destinatario: Cooperativa Demo',
  '',
  '1) Vino Rosso DOC - 24 pz',
  '2) Vino Bianco IGT - 12 pz',
  '',
  'Vettore: Mittente',
  'Causale: Vendita',
];

const RECEIPT_LINES = [
  'BAR ESEMPIO',
  'P.IVA 01122334459',
  'DOCUMENTO COMMERCIALE',
  'di vendita o prestazione',
  '',
  'Data: 25/10/2026',
  'Pranzo di lavoro 40,00',
  'Caffe 5,80',
  '',
  'TOTALE EURO 45,80',
];

const CERTIFICATE_LINES = [
  'CERTIFICATO DI CONFORMITA',
  'Produzione biologica',
  '',
  'Organismo di controllo: Ente Certificatore Esempio',
  'Operatore: Agricola Esempio S.r.l.',
  'Certificato N. BIO-2026-0042',
  'Data di emissione: 01/03/2026',
  'Data di scadenza: 28/02/2027',
];

type RenderOptions = { width: number; photo?: boolean };

function drawLines(ctx: SKRSContext2D, lines: string[], fontSize: number, margin: number): void {
  ctx.fillStyle = '#111111';
  ctx.font = `${fontSize}px Arial`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, margin, margin + i * fontSize * 1.6));
}

/** Renders text as a page image; `photo` adds a tilt, a grey background and noise. */
function renderPage(lines: string[], options: RenderOptions): Buffer {
  const fontSize = 30;
  const margin = 70;
  const height = margin * 2 + lines.length * fontSize * 1.6;
  const canvas = createCanvas(options.width, Math.ceil(height));
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = options.photo ? '#e9e6df' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (options.photo) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((1.2 * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }
  drawLines(ctx, lines, fontSize, margin);

  if (options.photo) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Deterministic speckle noise, so the fixture is reproducible.
    let seed = 42;
    for (let i = 0; i < 4000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = seed % canvas.width;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const y = seed % canvas.height;
      ctx.fillStyle = `rgba(80,80,80,${(seed % 40) / 100})`;
      ctx.fillRect(x, y, 2, 2);
    }
    return canvas.toBuffer('image/jpeg', 82);
  }
  return canvas.toBuffer('image/png');
}

async function textPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 790 - i * 20, size: 12, font }));
  return pdf.save();
}

async function scannedPdf(jpeg: Buffer): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(jpeg);
  const scale = 595 / image.width;
  const page = pdf.addPage([595, image.height * scale]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: image.height * scale });
  return pdf.save();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, data: Uint8Array) => {
    writeFileSync(path.join(OUT_DIR, name), data);
    console.log(`written ${name} (${data.length} bytes)`);
  };

  const ddtPhoto = renderPage(DDT_LINES, { width: 1240, photo: true });

  write('invoice.png', renderPage(INVOICE_LINES, { width: 1240 }));
  write('invoice-photo.jpg', renderPage(INVOICE_LINES, { width: 1240, photo: true }));
  write('invoice-digital.pdf', await textPdf(INVOICE_LINES));
  write('ddt-photo.jpg', ddtPhoto);
  write('ddt-scanned.pdf', await scannedPdf(ddtPhoto));
  write('receipt-photo.jpg', renderPage(RECEIPT_LINES, { width: 760, photo: true }));
  write('certificate.png', renderPage(CERTIFICATE_LINES, { width: 1240 }));
}

void main();
