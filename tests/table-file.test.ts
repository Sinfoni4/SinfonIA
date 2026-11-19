/**
 * The exports as Excel or PDF: the CSV the dashboard already has, converted. The Excel file keeps
 * codes with leading zeros as text and never turns a value into a formula; the PDF draws Italian
 * letters, leaves out emoji and splits long tables into pages.
 */
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { parseCsv, tableFile, tableFileName } from '../src/shared/table-file.js';

const CSV =
  '﻿"Data","Organizzazione","Tipo","Quantità","Partita IVA","Nota"\r\n' +
  '"2026-11-18 10:05","Azienda Agricola «Collio»","Pagine lette con OCR",4,"01234567890","=1+1"\r\n' +
  '"2026-11-18 11:00","Cantina ""Sole""","Documenti ricevuti",-1,"","rettifica, doppia"\r\n';

describe('CSV of the exports', () => {
  it('reads quoted fields, commas, semicolons and the BOM', () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([
      '2026-11-18 11:00',
      'Cantina "Sole"',
      'Documenti ricevuti',
      '-1',
      '',
      'rettifica, doppia',
    ]);
    expect(parseCsv('a;b\n1;"x;y"\n')).toEqual([
      ['a', 'b'],
      ['1', 'x;y'],
    ]);
  });

  it('names the file after the title, without accents or symbols', () => {
    expect(tableFileName('📄 Consumi dal 01/11/2026 al 30/11/2026', 'xlsx')).toBe(
      'consumi-dal-01-11-2026-al-30-11-2026.xlsx',
    );
    expect(tableFileName('', 'pdf')).toBe('export.pdf');
  });
});

describe('Excel and PDF files', () => {
  it('writes an Excel sheet with numbers as numbers, codes and formulas as text', async () => {
    const file = await tableFile({ title: 'Consumi di novembre', csv: CSV, format: 'xlsx' });
    expect(file.fileName).toBe('consumi-di-novembre.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Consumi di novembre')!;
    expect(sheet.getRow(1).getCell(4).value).toBe('Quantità');
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.getRow(2).getCell(2).value).toBe('Azienda Agricola «Collio»');
    expect(sheet.getRow(2).getCell(4).value).toBe(4);
    expect(sheet.getRow(3).getCell(4).value).toBe(-1);
    // A VAT number with a leading zero stays as written.
    expect(sheet.getRow(2).getCell(5).value).toBe('01234567890');
    // Never a formula.
    expect(sheet.getRow(2).getCell(6).value).toBe('=1+1');
    expect(sheet.getRow(2).getCell(6).formula).toBeUndefined();
  });

  it('writes a PDF, on more pages when the table is long', async () => {
    const short = await tableFile({ title: '📄 Export pratiche', csv: CSV, format: 'pdf' });
    expect(short.mimeType).toBe('application/pdf');
    expect(short.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(short.content)).getPageCount()).toBe(1);

    const long = [
      '"Nome","Data"',
      ...Array.from({ length: 120 }, (_, i) => `"Pratica ${i}","2026"`),
    ];
    const file = await tableFile({ title: 'Pratiche', csv: long.join('\n'), format: 'pdf' });
    expect((await PDFDocument.load(file.content)).getPageCount()).toBeGreaterThan(1);
  });
});
