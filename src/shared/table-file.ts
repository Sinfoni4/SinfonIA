import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The exports of the dashboard (practices, usage) as Excel or PDF files, from the same CSV text
 * the dashboard already receives: one table, a header row and the data rows. Values are never
 * interpreted as formulas.
 */

export type TableFormat = 'xlsx' | 'pdf';

export type TableFile = { fileName: string; mimeType: string; content: Buffer };

type Cell = string;

/** Parses CSV text (comma or semicolon, quoted fields, an optional BOM). */
export function parseCsv(text: string): Cell[][] {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** A number for Excel only when it is plainly one: codes with leading zeros stay text. */
function asNumber(value: string): number | null {
  if (!/^-?(0|[1-9]\d{0,13})(\.\d+)?$/.test(value)) return null;
  return Number(value);
}

/** A file name without accents or symbols, from the title. */
export function tableFileName(title: string, format: TableFormat): string {
  const base = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${base || 'export'}.${format}`;
}

async function toXlsx(title: string, rows: Cell[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SinfonIA';
  // A sheet name: at most 31 characters, none of []:*?/\
  const name =
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Export';
  const sheet = workbook.addWorksheet(name);
  const [header = [], ...data] = rows;
  sheet.addRow(header);
  for (const r of data) {
    // A text starting with = + - @ is never a formula: ExcelJS writes strings as strings.
    sheet.addRow(r.map((c) => asNumber(c) ?? c));
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (header.length > 0 && data.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  }
  header.forEach((_, i) => {
    const longest = Math.max(...rows.map((r) => (r[i] ?? '').length));
    sheet.getColumn(i + 1).width = Math.min(50, Math.max(10, longest + 2));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Keeps only the characters the standard PDF font can draw (Italian letters, € and « » too). */
function drawable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      // An emoji or a character outside the font: left out.
    }
  }
  return out.trim();
}

function fit(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Most lines a cell takes in the PDF: a longer text ends with «…». */
export const PDF_MAX_CELL_LINES = 8;

/**
 * A cell's text broken into lines that fit the column, at the spaces; a word longer than the
 * column is split. At most `maxLines` lines: the last one ends with «…» when text is left out.
 */
export function wrapCell(
  font: PDFFont,
  text: string,
  size: number,
  width: number,
  maxLines = PDF_MAX_CELL_LINES,
): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    // A word wider than the column: split it where it no longer fits.
    while (!fits(line) && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && !fits(line.slice(0, cut))) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  // The last kept line always ends with «…»: text follows it.
  let last = kept[maxLines - 1];
  while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

async function toPdf(title: string, rows: Cell[][]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('SinfonIA');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [header = [], ...data] = rows.map((r) => r.map((c) => drawable(font, c)));
  // A4 landscape, 36 pt margins.
  const pageSize: [number, number] = [842, 595];
  const margin = 36;
  const size = 8;
  const lineHeight = 14;
  const usable = pageSize[0] - 2 * margin;
  const columns = Math.max(1, header.length);
  // Columns as wide as their content asks, within the page.
  const wants = Array.from({ length: columns }, (_, i) =>
    Math.min(
      220,
      Math.max(40, ...[header, ...data].map((r) => font.widthOfTextAtSize(r[i] ?? '', size) + 8)),
    ),
  );
  const scale = usable / wants.reduce((a, b) => a + b, 0);
  const widths = wants.map((w) => w * scale);

  let page: PDFPage = pdf.addPage(pageSize);
  let y = 0;
  let pageNumber = 0;
  // A cell goes on more lines instead of being cut: the row is as tall as its longest cell.
  const lineStep = size + 3;
  const wrapRow = (cells: string[], f: PDFFont) =>
    widths.map((w, i) => wrapCell(f, cells[i] ?? '', size, w - 6));
  const rowHeight = (lines: string[][]) =>
    Math.max(1, ...lines.map((l) => l.length)) * lineStep + (lineHeight - lineStep);
  const drawRow = (lines: string[][], f: PDFFont) => {
    let x = margin;
    lines.forEach((cellLines, i) => {
      cellLines.forEach((text, n) => {
        page.drawText(text, { x: x + 3, y: y - n * lineStep, size, font: f });
      });
      x += widths[i];
    });
  };
  const headerLines = wrapRow(header, bold);
  const newPage = (first: boolean) => {
    if (!first) page = pdf.addPage(pageSize);
    pageNumber++;
    y = pageSize[1] - margin;
    page.drawText(fit(bold, drawable(bold, title), 13, usable), {
      x: margin,
      y,
      size: 13,
      font: bold,
    });
    page.drawText(`Pagina ${pageNumber}`, {
      x: pageSize[0] - margin - 50,
      y: margin / 2,
      size: 8,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= 24;
    drawRow(headerLines, bold);
    y -= rowHeight(headerLines) - lineHeight;
    page.drawLine({
      start: { x: margin, y: y - 4 },
      end: { x: pageSize[0] - margin, y: y - 4 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= lineHeight + 2;
  };
  newPage(true);
  if (data.length === 0) {
    page.drawText('Nessun dato.', { x: margin, y, size, font });
  }
  for (const r of data) {
    const lines = wrapRow(r, font);
    const height = rowHeight(lines);
    // A row is never split across pages (a row taller than a page cannot happen: 8 lines at most).
    if (y - height + lineHeight < margin + lineHeight) newPage(false);
    drawRow(lines, font);
    y -= height;
    // A thin line between rows, so a row on more lines reads as one.
    page.drawLine({
      start: { x: margin, y: y + lineHeight - 4 },
      end: { x: pageSize[0] - margin, y: y + lineHeight - 4 },
      thickness: 0.25,
      color: rgb(0.85, 0.85, 0.85),
    });
  }
  return Buffer.from(await pdf.save());
}

/** The body of a conversion request: the CSV of an export the person already received. */
export const TABLE_FILE_MAX_CSV = 5 * 1024 * 1024;

/** The CSV of an export as an Excel or PDF file, named after its title. */
export async function tableFile(input: {
  title: string;
  csv: string;
  format: TableFormat;
}): Promise<TableFile> {
  return tableFileFromRows({ title: input.title, rows: parseCsv(input.csv), format: input.format });
}

/** A table (a header row and the data rows) as an Excel or PDF file, named after its title. */
export async function tableFileFromRows(input: {
  title: string;
  rows: string[][];
  format: TableFormat;
}): Promise<TableFile> {
  const { rows } = input;
  return input.format === 'xlsx'
    ? {
        fileName: tableFileName(input.title, 'xlsx'),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: await toXlsx(input.title, rows),
      }
    : {
        fileName: tableFileName(input.title, 'pdf'),
        mimeType: 'application/pdf',
        content: await toPdf(input.title, rows),
      };
}
