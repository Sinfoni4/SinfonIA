/**
 * Generates a varied set of fictitious PDF documents, with their expected values, to measure the
 * basic behaviour of the OCR pipeline before testing real phone photos.
 *
 * Variations: document type (invoice, delivery note, receipt, certificate), label wording as
 * different suppliers write it, layout (one value per line, values on one row, right-aligned
 * amounts), and rendering (digital text layer, good scan, poor scan, two pages).
 * Every company, VAT number and amount is made up; VAT numbers have a valid check digit.
 *
 *   npx tsx scripts/generate-ocr-pdf-samples.ts [--out ocr-samples/pdf-sintetici]
 *   npm run ocr:accuracy -- --dir ocr-samples/pdf-sintetici
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';

type Rendering = 'digital' | 'scan' | 'poor-scan' | 'two-pages';

type Sample = {
  name: string;
  rendering: Rendering;
  lines: string[];
  expected: { documentType: string; fields: Record<string, string | number> };
};

// Deterministic pseudo-random numbers, so the set is reproducible.
let seed = 20261028;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/** A made-up Italian VAT number with a valid check digit. */
function vatNumber(): string {
  const digits = Array.from({ length: 10 }, () => Math.floor(random() * 10));
  let sum = 0;
  digits.forEach((d, i) => {
    if (i % 2 === 0) sum += d;
    else sum += d * 2 > 9 ? d * 2 - 9 : d * 2;
  });
  return digits.join('') + String((10 - (sum % 10)) % 10);
}

function euro(value: number): string {
  const [int, dec] = value.toFixed(2).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
function dateParts(day: number, month: number) {
  return { iso: `2026-${pad(month)}-${pad(day)}`, it: `${pad(day)}/${pad(month)}/2026` };
}

const COMPANIES = [
  ['Ortofrutta Collina', 'S.r.l.'],
  ['Cantina Valle Verde', 'S.p.A.'],
  ['Agricola Friulana', 'Soc. Coop.'],
  ['Forniture Rurali', 'S.r.l.'],
  ['Meccanica Agraria Nord', 'S.n.c.'],
  ['Sementi del Friuli', 'S.r.l.'],
  ['Trasporti Isonzo', 'S.r.l.'],
  ['Vivai Carso', 'S.a.s.'],
] as const;

const COOP = 'Cooperativa Demo Soc. Coop.';

function invoice(index: number, rendering: Rendering, style: number): Sample {
  const [company, form] = COMPANIES[index % COMPANIES.length]!;
  const supplierName = `${company} ${form}`;
  const vat = vatNumber();
  const coopVat = vatNumber();
  const taxable = Math.round((200 + random() * 4800) * 100) / 100;
  const vatAmount = Math.round(taxable * 0.22 * 100) / 100;
  const total = Math.round((taxable + vatAmount) * 100) / 100;
  const date = dateParts(1 + (index % 27), 1 + (index % 12));
  const number = `${2026}/${100 + index}`;

  // Different suppliers, different wording.
  const header = [
    [`P.IVA IT${vat}`, `FATTURA N. ${number}`, `Data: ${date.it}`],
    [`Partita IVA: ${vat}`, `Fattura nr. ${number} del ${date.it}`],
    [`C.F. e P.IVA ${vat}`, `Numero documento: ${number}`, `Data documento: ${date.it}`],
    [`P. IVA ${vat}`, `Fattura immediata n° ${number}`, `Data ${date.it.replace(/\//g, '.')}`],
  ][style % 4]!;
  const totals = [
    [
      `Imponibile: ${euro(taxable)}`,
      `IVA 22%: ${euro(vatAmount)}`,
      `Totale documento: ${euro(total)}`,
    ],
    [
      `Totale imponibile € ${euro(taxable)}`,
      `Totale IVA € ${euro(vatAmount)}`,
      `TOTALE FATTURA € ${euro(total)}`,
    ],
    [`Imponibile ${euro(taxable)}   IVA ${euro(vatAmount)}   Totale ${euro(total)}`],
    [
      `Imponibile: ${euro(taxable)}`,
      `Imposta: ${euro(vatAmount)}`,
      `Netto a pagare: ${euro(total)}`,
    ],
  ][style % 4]!;

  const vatOnFile = style % 4 === 0 ? `IT${vat}` : vat;
  return {
    name: `fattura-${pad(index + 1)}-${rendering}`,
    rendering,
    lines: [
      supplierName.toUpperCase(),
      'Via dei Vigneti 7 - 33100 Udine (UD)',
      ...header,
      '',
      `Cliente: ${COOP}`,
      `P.IVA cliente ${coopVat}`,
      '',
      'Descrizione            Q.ta     Prezzo      Importo',
      `Fornitura materiale     1     ${euro(taxable)}   ${euro(taxable)}`,
      '',
      ...totals,
      'Pagamento: bonifico 30 gg data fattura',
    ],
    expected: {
      documentType: 'invoice',
      fields: {
        supplierName,
        supplierVat: vatOnFile,
        documentNumber: number,
        documentDate: date.iso,
        taxableAmount: taxable,
        vatAmount,
        totalAmount: total,
      },
    },
  };
}

function deliveryNote(index: number, rendering: Rendering, style: number): Sample {
  const [company, form] = COMPANIES[(index + 3) % COMPANIES.length]!;
  const supplierName = `${company} ${form}`;
  const vat = vatNumber();
  const date = dateParts(2 + (index % 25), 1 + ((index + 4) % 12));
  const number = `DDT-${300 + index}`;
  const head = [
    ['DOCUMENTO DI TRASPORTO', `DDT N. ${number}`, `Data: ${date.it}`],
    ['D.D.T.', `Numero: ${number}`, `Data consegna: ${date.it}`],
    ['DOCUMENTO DI TRASPORTO (D.P.R. 472/96)', `N. documento ${number} del ${date.it}`],
  ][style % 3]!;
  return {
    name: `ddt-${pad(index + 1)}-${rendering}`,
    rendering,
    lines: [
      ...head,
      `Mittente: ${supplierName}`,
      `P.IVA ${vat}`,
      `Destinatario: ${COOP}`,
      'Luogo di destinazione: Magazzino sociale, Via Roma 1, Cormons',
      '',
      '1) Concime organico - 20 sacchi',
      '2) Rete antigrandine - 4 rotoli',
      '',
      'Causale del trasporto: Vendita',
      'Trasporto a cura del: Mittente',
    ],
    expected: {
      documentType: 'delivery_note',
      fields: {
        supplierName,
        supplierVat: vat,
        documentNumber: number,
        documentDate: date.iso,
        recipientName: COOP,
      },
    },
  };
}

function receipt(index: number, rendering: Rendering, style: number): Sample {
  const shops = [
    'BAR CENTRALE',
    'FERRAMENTA ROSSI',
    'PANIFICIO DEL BORGO',
    'AGRARIA MODERNA',
    'TABACCHI N. 12',
  ];
  const merchantName = shops[index % shops.length]!;
  const vat = vatNumber();
  const date = dateParts(3 + (index % 24), 1 + ((index + 7) % 12));
  const total = Math.round((3 + random() * 180) * 100) / 100;
  const totalLine = [
    `TOTALE EURO ${euro(total)}`,
    `TOTALE COMPLESSIVO ${euro(total)}`,
    `Totale € ${euro(total)}`,
  ][style % 3]!;
  return {
    name: `scontrino-${pad(index + 1)}-${rendering}`,
    rendering,
    lines: [
      merchantName,
      'Via Garibaldi 4 - Gorizia',
      `P.IVA ${vat}`,
      'DOCUMENTO COMMERCIALE',
      'di vendita o prestazione',
      '',
      `Articolo vario          ${euro(total)}`,
      '',
      totalLine,
      `Data: ${date.it} ore 10:42`,
    ],
    expected: {
      documentType: 'receipt',
      fields: { merchantName, merchantVat: vat, documentDate: date.iso, totalAmount: total },
    },
  };
}

function certificate(index: number, rendering: Rendering): Sample {
  const kinds = [
    {
      category: 'BIO',
      title: 'CERTIFICATO DI CONFORMITA',
      subtitle: 'Produzione biologica',
      prefix: 'BIO',
    },
    {
      category: 'DURC',
      title: 'DURC - DOCUMENTO UNICO DI REGOLARITA CONTRIBUTIVA',
      subtitle: 'INPS - INAIL',
      prefix: 'INAIL',
    },
    {
      category: 'SICUREZZA_LAVORO',
      title: 'ATTESTATO DI FORMAZIONE',
      subtitle: 'Sicurezza sul lavoro - D.Lgs. 81/08',
      prefix: 'SIC',
    },
    {
      category: 'PATENTINO',
      title: 'CERTIFICATO DI ABILITAZIONE',
      subtitle: 'Patentino uso prodotti fitosanitari',
      prefix: 'FITO',
    },
    {
      category: 'VISITA_MEDICA',
      title: 'CERTIFICATO DI IDONEITA',
      subtitle: 'Visita medica del lavoro',
      prefix: 'MED',
    },
  ];
  const kind = kinds[index % kinds.length]!;
  const issue = dateParts(1 + index, 2 + index);
  const expiry = {
    iso: `2027-${pad(2 + index)}-${pad(1 + index)}`,
    it: `${pad(1 + index)}/${pad(2 + index)}/2027`,
  };
  const number = `${kind.prefix}-2026-${String(40 + index).padStart(4, '0')}`;
  return {
    name: `certificato-${pad(index + 1)}-${rendering}`,
    rendering,
    lines: [
      kind.title,
      kind.subtitle,
      '',
      'Rilasciato da: Ente Esempio di Certificazione',
      `Intestatario: ${COMPANIES[index]![0]} ${COMPANIES[index]![1]}`,
      `Certificato N. ${number}`,
      `Data di emissione: ${issue.it}`,
      `Data di scadenza: ${expiry.it}`,
    ],
    expected: {
      documentType: 'certificate',
      fields: {
        category: kind.category,
        certificateNumber: number,
        issueDate: issue.iso,
        expiryDate: expiry.iso,
      },
    },
  };
}

/** A page image as a scanner would produce it; `poor` is low resolution, tilted and noisy. */
function scanImage(lines: string[], poor: boolean): Buffer {
  const width = poor ? 900 : 1240;
  const fontSize = poor ? 20 : 28;
  const margin = poor ? 50 : 70;
  const height = Math.round(width * 1.414);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = poor ? '#ecebe6' : '#fdfdfd';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(((poor ? 1.5 : 0.4) * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = '#151515';
  ctx.font = `${fontSize}px Arial`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, margin, margin + i * fontSize * 1.6));
  ctx.restore();
  if (poor) {
    for (let i = 0; i < 6000; i++) {
      ctx.fillStyle = `rgba(70,70,70,${random() * 0.35})`;
      ctx.fillRect(Math.floor(random() * width), Math.floor(random() * height), 2, 2);
    }
  }
  return canvas.toBuffer('image/jpeg', poor ? 60 : 85);
}

async function buildPdf(sample: Sample): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  if (sample.rendering === 'digital' || sample.rendering === 'two-pages') {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    // Two pages: the totals and payment terms end up on the second one.
    const split =
      sample.rendering === 'two-pages' ? Math.ceil(sample.lines.length / 2) : sample.lines.length;
    for (const chunk of [sample.lines.slice(0, split), sample.lines.slice(split)]) {
      if (chunk.length === 0) continue;
      const page = pdf.addPage([595, 842]);
      chunk.forEach((line, i) =>
        page.drawText(line.replace(/€/g, 'EUR'), { x: 50, y: 790 - i * 20, size: 11, font }),
      );
    }
  } else {
    const image = await pdf.embedJpg(scanImage(sample.lines, sample.rendering === 'poor-scan'));
    const page = pdf.addPage([595, 842]);
    page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  }
  return pdf.save();
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(
    outIndex >= 0 ? process.argv[outIndex + 1]! : 'ocr-samples/pdf-sintetici',
  );
  mkdirSync(outDir, { recursive: true });

  const renderings: Rendering[] = ['digital', 'scan', 'poor-scan', 'two-pages'];
  const samples: Sample[] = [];
  for (let i = 0; i < 8; i++) samples.push(invoice(i, renderings[i % 4]!, i));
  for (let i = 0; i < 6; i++) samples.push(deliveryNote(i, renderings[i % 3]!, i));
  for (let i = 0; i < 5; i++) samples.push(receipt(i, renderings[i % 3]!, i));
  for (let i = 0; i < 5; i++) samples.push(certificate(i, renderings[i % 2]!));

  for (const sample of samples) {
    // pdf-lib's standard fonts cannot encode "€": digital PDFs write "EUR" instead (see buildPdf).
    writeFileSync(path.join(outDir, `${sample.name}.pdf`), await buildPdf(sample));
    writeFileSync(
      path.join(outDir, `${sample.name}.expected.json`),
      `${JSON.stringify(sample.expected, null, 2)}\n`,
    );
  }
  console.log(`${samples.length} PDF generati in ${outDir}`);
}

void main();
