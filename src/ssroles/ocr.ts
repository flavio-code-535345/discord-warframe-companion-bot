import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Worker, createWorker } from 'tesseract.js';
import type { OcrLine } from './parse.js';

/**
 * Tesseract compiled to WebAssembly (tesseract.js): no native program, so the same node_modules works in the
 * amd64 and arm64 images. The English data ships in an npm package, so nothing is downloaded or cached on disk.
 * Images only ever exist in memory. The worker is created on first use and released again when idle.
 */

const IDLE_MS = 5 * 60_000;

export class OcrEngine {
  private worker: Promise<Worker> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private langPath(): string {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  }

  private getWorker(): Promise<Worker> {
    this.worker ??= createWorker('eng', 1, { langPath: this.langPath(), gzip: true, cacheMethod: 'none' }).catch((err) => {
      this.worker = null;
      throw err;
    });
    return this.worker;
  }

  /** Reads one image (PNG or JPEG bytes) and returns its text lines with positions. One image at a time. */
  recognize(image: Uint8Array): Promise<OcrLine[]> {
    const run = async () => {
      if (this.idle) clearTimeout(this.idle);
      try {
        const worker = await this.getWorker();
        const result = await worker.recognize(Buffer.from(image), {}, { blocks: true });
        const lines = (result.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
        return lines.map((l) => ({ text: l.text, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, confidence: l.confidence }));
      } finally {
        this.idle = setTimeout(() => void this.release(), IDLE_MS);
        this.idle.unref();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async release(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await (await worker).terminate().catch(() => {});
  }
}

export const ocr = new OcrEngine();
