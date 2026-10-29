import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/**
 * CPU-bound document work in a worker thread: PDF parsing and page rendering, and image
 * preprocessing for OCR.
 *
 * pdf.js and the canvas renderer run on the calling thread: a scanned page at scale 2 kept the
 * Node event loop busy for about 0.7 s, during which no HTTP request, health check or Telegram
 * update was served. Pixel-level preprocessing has the same cost. OCR itself already runs in
 * Tesseract's own worker.
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

/** Turns a photo into a clean black-and-white PNG for a second OCR read. */
export interface ImagePreprocessor {
  preprocess(image: Buffer): Promise<Buffer>;
}

// Plain CommonJS so it runs the same under tsx, Vitest and the compiled build. Modules are loaded
// from paths resolved by the main thread, independent of the worker's working directory.
// Requests are handled one at a time: processing several documents at once would only add memory
// pressure.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const unpdf = require(workerData.unpdfPath);
const canvas = require(workerData.canvasPath);
const canvasImport = () => Promise.resolve(canvas);
let queue = Promise.resolve();

async function extractPdf({ data, maxPages, minTextChars }) {
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

// Small photos (Telegram compresses them to 1280 px) are enlarged, then binarized with an
// adaptive (Bradley-Roth) threshold: each pixel is compared with the mean of its neighbourhood,
// which copes with the shadows and folds of thermal receipts where a global threshold fails.
async function preprocess({ data }) {
  const image = await canvas.loadImage(Buffer.from(data));
  const scale = Math.max(image.width, image.height) < 2000 ? 2 : 1;
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const surface = canvas.createCanvas(w, h);
  const ctx = surface.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);
  const px = frame.data;

  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += gray[(y - 1) * w + x - 1];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
    }
  }
  const radius = Math.max(7, Math.round(w / 70));
  const k = 0.15;
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(w, x + radius + 1);
      const sum =
        integral[y2 * (w + 1) + x2] - integral[y1 * (w + 1) + x2] -
        integral[y2 * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      const mean = sum / ((x2 - x1) * (y2 - y1));
      const value = gray[y * w + x] < mean * (1 - k) ? 0 : 255;
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = value;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(frame, 0, 0);
  return { image: new Uint8Array(surface.toBuffer('image/png')) };
}

parentPort.on('message', (request) => {
  queue = queue.then(async () => {
    try {
      const result = request.op === 'preprocess' ? await preprocess(request) : await extractPdf(request);
      const buffers = result.images ? result.images.map((i) => i.buffer) : [result.image.buffer];
      parentPort.postMessage({ id: request.id, ok: true, result }, buffers);
    } catch (err) {
      parentPort.postMessage({ id: request.id, ok: false, error: String((err && err.message) || err) });
    }
  });
});
`;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerReply =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export class DocumentWorker implements PdfExtractor, ImagePreprocessor {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** @param timeoutMs per document; on expiry the worker is restarted, so a stuck PDF cannot pile up. */
  constructor(private readonly timeoutMs = 60_000) {}

  async extract(
    content: Buffer,
    options: { maxPages: number; minTextChars: number },
  ): Promise<PdfExtraction> {
    const result = (await this.request({ op: 'pdf', ...options }, content)) as {
      totalPages: number;
      text: string | null;
      images: Uint8Array[];
    };
    return {
      totalPages: result.totalPages,
      text: result.text,
      images: result.images.map((image) => Buffer.from(image)),
    };
  }

  async preprocess(image: Buffer): Promise<Buffer> {
    const result = (await this.request({ op: 'preprocess' }, image)) as { image: Uint8Array };
    return Buffer.from(result.image);
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('Document worker terminated'));
    await worker?.terminate();
  }

  private request(message: Record<string, unknown>, content: Buffer): Promise<unknown> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error('Document processing timed out'));
        void this.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // A copy, transferred: the caller keeps its buffer (it is also stored as the attachment).
      const data = new Uint8Array(content).buffer;
      worker.postMessage({ ...message, id, data }, [data]);
    });
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
      this.failAll(new Error('Document worker exited'));
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
      pending.resolve(reply.result);
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
