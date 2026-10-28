import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/**
 * PDF parsing and page rendering in a worker thread.
 *
 * pdf.js and the canvas renderer are CPU-bound and run on the calling thread: a scanned page at
 * scale 2 kept the Node event loop busy for about 0.7 s, during which no HTTP request, health
 * check or Telegram update was served. The worker does that work off the main thread; OCR itself
 * already runs in Tesseract's own worker.
 */

export type PdfExtraction = {
  totalPages: number;
  /** Text layer, when it has at least `minTextChars` non-space characters (digital PDF). */
  text: string | null;
  /** PNG renderings of the first pages, when the PDF has no usable text layer (scanned). */
  images: Buffer[];
};

export interface PdfExtractor {
  extract(
    content: Buffer,
    options: { maxPages: number; minTextChars: number },
  ): Promise<PdfExtraction>;
  terminate(): Promise<void>;
}

// Plain CommonJS so it runs the same under tsx, Vitest and the compiled build. Modules are loaded
// from paths resolved by the main thread, independent of the worker's working directory.
// Requests are handled one at a time: rendering several PDFs at once would only add memory pressure.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const unpdf = require(workerData.unpdfPath);
const canvasImport = () => Promise.resolve(require(workerData.canvasPath));
let queue = Promise.resolve();

async function extract({ data, maxPages, minTextChars }) {
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(data));
  try {
    const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: true });
    if (text.replace(/\\s/g, '').length >= minTextChars) {
      return { totalPages, text, images: [] };
    }
    const images = [];
    const pages = Math.min(pdf.numPages, maxPages);
    for (let page = 1; page <= pages; page++) {
      const png = await unpdf.renderPageAsImage(pdf, page, { canvasImport, scale: 2 });
      images.push(new Uint8Array(png));
    }
    return { totalPages: pdf.numPages, text: null, images };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

parentPort.on('message', (request) => {
  queue = queue.then(async () => {
    try {
      const result = await extract(request);
      parentPort.postMessage(
        { id: request.id, ok: true, result },
        result.images.map((image) => image.buffer),
      );
    } catch (err) {
      parentPort.postMessage({ id: request.id, ok: false, error: String((err && err.message) || err) });
    }
  });
});
`;

type Pending = {
  resolve: (value: PdfExtraction) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerReply =
  | {
      id: number;
      ok: true;
      result: { totalPages: number; text: string | null; images: Uint8Array[] };
    }
  | { id: number; ok: false; error: string };

export class WorkerPdfExtractor implements PdfExtractor {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** @param timeoutMs per document; on expiry the worker is restarted, so a stuck PDF cannot pile up. */
  constructor(private readonly timeoutMs = 60_000) {}

  extract(
    content: Buffer,
    options: { maxPages: number; minTextChars: number },
  ): Promise<PdfExtraction> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<PdfExtraction>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error('PDF processing timed out'));
        void this.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // A copy, transferred: the caller keeps its buffer (it is also stored as the attachment).
      const data = new Uint8Array(content).buffer;
      worker.postMessage({ id, data, ...options }, [data]);
    });
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('PDF worker terminated'));
    await worker?.terminate();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const require = createRequire(import.meta.url);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        unpdfPath: require.resolve('unpdf'),
        canvasPath: require.resolve('@napi-rs/canvas'),
      },
    });
    worker.on('message', (reply: WorkerReply) => this.settle(reply));
    worker.on('error', (err: unknown) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      if (this.worker === worker) this.worker = null;
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
      this.failAll(new Error('PDF worker exited'));
    });
    // An idle worker must not keep the process alive (shutdown, tests).
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private settle(reply: WorkerReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) {
      pending.resolve({
        totalPages: reply.result.totalPages,
        text: reply.result.text,
        images: reply.result.images.map((image) => Buffer.from(image)),
      });
    } else {
      pending.reject(new Error(reply.error));
    }
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
