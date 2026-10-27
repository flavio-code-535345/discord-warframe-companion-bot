import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import wasmWebp from '@saschazar/wasm-webp';
import { PNG } from 'pngjs';

/**
 * WebP decoding with libwebp compiled to WebAssembly (no native module, so the amd64-to-arm64 Docker image keeps working). A WebP
 * is converted to a PNG up front, so the rest of the image code (PNG and JPEG only, synchronous) never needs to know about it.
 *
 * The module can decode only once after it is created (it cannot be used again after `free()`), and creating one is cheap, so every
 * picture gets a fresh instance that is thrown away afterwards.
 */

interface Module {
  decode(buffer: Uint8Array, length: number, alpha: boolean): Uint8Array;
  dimensions(): { width: number; height: number; channels: number };
  free(): void;
}

let wasmBinary: Buffer | null = null;

export interface WebpPixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

/** Decodes a WebP picture to RGBA pixels, or returns null when it is damaged. */
export function decodeWebp(bytes: Uint8Array): Promise<WebpPixels | null> {
  return new Promise((resolve) => {
    try {
      // The wasm file is handed over as bytes: the loader would otherwise try to fetch() it, which fails for a file path on Node 24.
      wasmBinary ??= readFileSync(createRequire(import.meta.url).resolve('@saschazar/wasm-webp/wasm_webp.wasm'));
      // The returned object is only a thenable; the real methods are on `this` inside onRuntimeInitialized.
      (wasmWebp as unknown as (o: object) => unknown)({
        wasmBinary,
        onRuntimeInitialized(this: Module) {
          try {
            const out = this.decode(bytes, bytes.length, true);
            const { width, height } = this.dimensions();
            const data = Uint8Array.from(out);
            this.free();
            resolve(width && height && data.length >= width * height * 4 ? { width, height, data } : null);
          } catch {
            resolve(null);
          }
        },
      });
    } catch {
      resolve(null);
    }
  });
}

/** A WebP picture as PNG bytes (what the text reader and the image code understand), or null when it cannot be decoded. */
export async function webpToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const px = await decodeWebp(bytes);
  if (!px) return null;
  const png = new PNG({ width: px.width, height: px.height });
  png.data = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.length);
  return PNG.sync.write(png);
}
