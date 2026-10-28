import { readFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { afterAll, describe, expect, it } from 'vitest';

import { DocumentWorker } from '../src/ai/ocr/document-worker.js';
import { DocumentTextExtractor, type OcrEngine } from '../src/ai/ocr/text-extraction.js';

const fixture = (name: string) => readFileSync(path.join('tests/fixtures/ocr', name));
const options = { maxPages: 5, minTextChars: 30 };

// Instant fake OCR: what is measured here is PDF parsing and rendering only.
const fakeOcr: OcrEngine = {
  recognize: () => Promise.resolve({ text: 'testo', confidence: 90 }),
  terminate: () => Promise.resolve(),
};

describe('document worker thread', () => {
  const extractor = new DocumentWorker();

  afterAll(async () => {
    await extractor.terminate();
  });

  it('reads digital PDFs from the text layer and renders scanned ones', async () => {
    const digital = await extractor.extract(fixture('invoice-digital.pdf'), options);
    expect(digital.text).toContain('2026/118');
    expect(digital.images).toEqual([]);

    const scanned = await extractor.extract(fixture('ddt-scanned.pdf'), options);
    expect(scanned.text).toBeNull();
    expect(scanned.images).toHaveLength(1);
    // PNG signature.
    expect(scanned.images[0].subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it("does not block the server's event loop while rendering a scanned PDF", async () => {
    const textExtractor = new DocumentTextExtractor({
      ocrEngine: fakeOcr,
      documentWorker: extractor,
    });
    // Warm-up: worker start-up and module loading are not what is measured.
    await textExtractor.extract(fixture('ddt-scanned.pdf'), 'pdf');

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const result = await textExtractor.extract(fixture('ddt-scanned.pdf'), 'pdf');
    histogram.disable();

    expect(result.source).toBe('ocr_pdf');
    // Rendering on the main thread blocked it for ~700 ms per page on a development PC.
    expect(histogram.max / 1e6).toBeLessThan(250);
  });

  it("leaves the caller's buffer intact", async () => {
    const content = fixture('invoice-digital.pdf');
    const copy = Buffer.from(content);
    await extractor.extract(content, options);
    expect(content.byteLength).toBe(copy.byteLength);
    expect(content.equals(copy)).toBe(true);
  });

  it('rejects a corrupt PDF and keeps working for the next one', async () => {
    await expect(
      extractor.extract(Buffer.from('%PDF-1.4 not really a pdf'), options),
    ).rejects.toThrow();
    const next = await extractor.extract(fixture('invoice-digital.pdf'), options);
    expect(next.text).toContain('2026/118');
  });

  it('restarts the worker when a document takes too long', async () => {
    const impatient = new DocumentWorker(1);
    await expect(impatient.extract(fixture('ddt-scanned.pdf'), options)).rejects.toThrow(
      'timed out',
    );
    await impatient.terminate();

    const patient = new DocumentWorker();
    try {
      const result = await patient.extract(fixture('invoice-digital.pdf'), options);
      expect(result.text).toContain('2026/118');
    } finally {
      await patient.terminate();
    }
  });

  it('fails pending requests on terminate', async () => {
    const short = new DocumentWorker();
    const pending = short.extract(fixture('ddt-scanned.pdf'), options);
    const assertion = expect(pending).rejects.toThrow('terminated');
    await short.terminate();
    await assertion;
  });
});
