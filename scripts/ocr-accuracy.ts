/**
 * Measures OCR accuracy on a folder of documents with known expected values.
 *
 * For every supported file (`.jpg`, `.jpeg`, `.png`, `.webp`, `.pdf`) the folder must contain
 * `<file name without extension>.expected.json`:
 *
 *   { "documentType": "invoice", "fields": { "totalAmount": 1525.61, "documentDate": "2026-10-15" } }
 *
 * Usage:
 *   npm run ocr:accuracy -- --dir <folder> [--out report.json]
 *
 * Real documents contain personal data: keep the folder outside the repository
 * (or in the git-ignored `ocr-samples/`) and see docs/PROTOCOLLO_PROVA_OCR.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { DocumentOcrService } from '../src/ai/ocr/document-ocr.service.js';

import type { DocumentOcrResult } from '../src/ai/ocr/ocr.types.js';

type Expected = { documentType: string; fields: Record<string, string | number> };

type FieldCheck = { field: string; expected: unknown; actual: unknown; ok: boolean };

type DocumentReport = {
  file: string;
  expectedType: string;
  actualType: string;
  typeOk: boolean;
  fields: FieldCheck[];
  reviewRequired: boolean;
  confidence: number | null;
  ms: number;
};

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(expected - actual) <= 0.01;
  }
  return normalize(expected) === normalize(actual);
}

function percent(ok: number, total: number): string {
  return total === 0 ? '-' : `${((ok / total) * 100).toFixed(1)}% (${ok}/${total})`;
}

async function main() {
  const dir = argValue('--dir');
  if (!dir || !existsSync(dir)) {
    console.error('Usage: npm run ocr:accuracy -- --dir <folder> [--out report.json]');
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter((f) => SUPPORTED.has(path.extname(f).toLowerCase()))
    .sort();
  const service = new DocumentOcrService();
  const reports: DocumentReport[] = [];

  try {
    for (const file of files) {
      const expectedPath = path.join(dir, `${path.parse(file).name}.expected.json`);
      if (!existsSync(expectedPath)) {
        console.warn(`skip ${file}: missing ${path.basename(expectedPath)}`);
        continue;
      }
      const expected = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Expected;

      const start = performance.now();
      const result: DocumentOcrResult = await service.processDocument(
        readFileSync(path.join(dir, file)),
        '',
        file,
      );
      const ms = Math.round(performance.now() - start);
      const actual = result as unknown as Record<string, unknown>;

      reports.push({
        file,
        expectedType: expected.documentType,
        actualType: result.documentType,
        typeOk: result.documentType === expected.documentType,
        fields: Object.entries(expected.fields).map(([field, value]) => ({
          field,
          expected: value,
          actual: actual[field] ?? null,
          ok: sameValue(value, actual[field]),
        })),
        reviewRequired: result.reviewRequired,
        confidence: result.extraction?.confidence ?? null,
        ms,
      });

      const last = reports[reports.length - 1]!;
      const wrong = last.fields.filter((f) => !f.ok);
      console.log(
        `${last.typeOk && wrong.length === 0 ? 'OK  ' : 'FAIL'} ${file} [${result.documentType}] ` +
          `${last.fields.length - wrong.length}/${last.fields.length} campi, ${ms} ms` +
          (wrong.length
            ? `\n     errati: ${wrong.map((f) => `${f.field} (atteso ${String(f.expected)}, letto ${String(f.actual)})`).join('; ')}`
            : ''),
      );
    }
  } finally {
    await service.terminate();
  }

  const allFields = reports.flatMap((r) =>
    r.fields.map((f) => ({ ...f, review: r.reviewRequired })),
  );
  const byField = new Map<string, { ok: number; total: number }>();
  for (const f of allFields) {
    const entry = byField.get(f.field) ?? { ok: 0, total: 0 };
    entry.total++;
    if (f.ok) entry.ok++;
    byField.set(f.field, entry);
  }
  // The dangerous case: a wrong value delivered without asking for human review.
  const silentErrors = allFields.filter((f) => !f.ok && !f.review).length;
  const confidences = reports.map((r) => r.confidence).filter((c): c is number => c !== null);

  console.log('\n=== RIEPILOGO ===');
  console.log(`Documenti:                 ${reports.length}`);
  console.log(
    `Tipo documento corretto:   ${percent(reports.filter((r) => r.typeOk).length, reports.length)}`,
  );
  console.log(
    `Campi corretti:            ${percent(allFields.filter((f) => f.ok).length, allFields.length)}`,
  );
  console.log(`Errori senza revisione:    ${percent(silentErrors, allFields.length)}`);
  console.log(
    `Marcati da verificare:     ${percent(reports.filter((r) => r.reviewRequired).length, reports.length)}`,
  );
  if (confidences.length) {
    const avg = confidences.reduce((s, c) => s + c, 0) / confidences.length;
    console.log(`Confidenza OCR media:      ${avg.toFixed(1)}%`);
  }
  const avgMs = reports.reduce((s, r) => s + r.ms, 0) / Math.max(reports.length, 1);
  console.log(`Tempo medio per documento: ${Math.round(avgMs)} ms`);
  console.log('\nPer campo:');
  for (const [field, { ok, total }] of [...byField.entries()].sort()) {
    console.log(`  ${field.padEnd(20)} ${percent(ok, total)}`);
  }

  const out = argValue('--out');
  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    console.log(`\nReport dettagliato: ${out}`);
  }
}

void main();
