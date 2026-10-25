import { deflateSync } from 'node:zlib';

/**
 * Image captchas without native dependencies: a 5×7 bitmap font drawn with random scale, shear, offset and
 * colour, overlaid with noise lines and dots, bent by a sine wave, and encoded as PNG by hand. Characters that
 * look alike when distorted (0/O/Q, 1/I/L, 2/Z, 5/S, B/6/8) are left out.
 */
export const CAPTCHA_CHARS = 'ACDEFGHJKMNPRTUVWXY23479';
export const CODE_LENGTH = 6;
export const WIDTH = 360;
export const HEIGHT = 120;

const G = (rows: string[]) => rows;
export const GLYPHS: Record<string, string[]> = {
  A: G([' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #']),
  B: G(['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### ']),
  C: G([' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### ']),
  D: G(['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### ']),
  E: G(['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####']),
  F: G(['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    ']),
  G: G([' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####']),
  H: G(['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #']),
  J: G(['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  ']),
  K: G(['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #']),
  M: G(['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #']),
  N: G(['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #']),
  P: G(['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    ']),
  R: G(['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #']),
  T: G(['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ']),
  U: G(['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### ']),
  V: G(['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  ']),
  W: G(['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # ']),
  X: G(['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #']),
  Y: G(['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  ']),
  '2': G([' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####']),
  '3': G(['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### ']),
  '4': G(['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # ']),
  '6': G(['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### ']),
  '7': G(['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   ']),
  '8': G([' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### ']),
  '9': G([' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  ']),
};

type Rng = () => number;
const between = (rng: Rng, a: number, b: number) => a + rng() * (b - a);

export function randomCode(rng: Rng = Math.random, length = CODE_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CAPTCHA_CHARS[Math.floor(rng() * CAPTCHA_CHARS.length)];
  return code;
}

// --- tiny RGB canvas ---

class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Uint8Array(w * h * 3);
  }
  set(x: number, y: number, [r, g, b]: number[]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = r!;
    this.px[i + 1] = g!;
    this.px[i + 2] = b!;
  }
  rect(x: number, y: number, size: number, color: number[]) {
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) this.set(x + dx, y + dy, color);
  }
  line(x0: number, y0: number, x1: number, y1: number, thick: number, color: number[]) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.rect(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick, color);
    }
  }
}

// --- PNG encoding (8-bit RGB, no filtering) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(c: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0; // filter: none
    Buffer.from(c.px.buffer, y * c.w * 3, c.w * 3).copy(raw, y * (c.w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draws `code` as a distorted PNG captcha. */
export function renderCaptcha(code: string, rng: Rng = Math.random): Buffer {
  const base = new Canvas(WIDTH, HEIGHT);
  // Speckled light background.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const v = 215 + Math.floor(rng() * 40);
      base.set(x, y, [v, v - Math.floor(rng() * 15), 255 - Math.floor(rng() * 25)]);
    }
  }
  // Background noise lines in mid tones, under the text.
  for (let i = 0; i < 5; i++) {
    const col = [Math.floor(between(rng, 120, 200)), Math.floor(between(rng, 120, 200)), Math.floor(between(rng, 120, 200))];
    base.line(between(rng, 0, WIDTH), between(rng, 0, HEIGHT), between(rng, 0, WIDTH), between(rng, 0, HEIGHT), 1, col);
  }
  // Characters: random scale, colour, offset and shear.
  // Each character gets its own slot so neighbours never merge; offsets stay inside the image.
  const slot = (WIDTH - 40) / code.length;
  [...code].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    const s = Math.round(between(rng, 6, 8));
    const shear = between(rng, -0.2, 0.2);
    const x0 = 20 + i * slot + (slot - 5 * s) / 2 + between(rng, -4, 4);
    const y0 = (HEIGHT - 7 * s) / 2 + between(rng, -8, 8);
    const col = [Math.floor(between(rng, 10, 110)), Math.floor(between(rng, 10, 110)), Math.floor(between(rng, 10, 110))];
    glyph.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell !== '#') return;
        const y = y0 + ry * s;
        base.rect(x0 + rx * s + (ry * s - 3.5 * s) * shear + between(rng, -1, 1), y + between(rng, -1, 1), s, col);
      });
    });
  });
  // Two thin lines crossing the text, then scattered dots.
  for (let i = 0; i < 2; i++) {
    const col = [Math.floor(between(rng, 40, 140)), Math.floor(between(rng, 40, 140)), Math.floor(between(rng, 40, 140))];
    base.line(0, between(rng, 20, HEIGHT - 20), WIDTH, between(rng, 20, HEIGHT - 20), 1, col);
  }
  for (let i = 0; i < 700; i++) {
    const v = Math.floor(rng() * 160);
    base.set(rng() * WIDTH, rng() * HEIGHT, [v, v, v]);
  }
  // Bend the whole picture with a sine wave so glyph edges aren't straight.
  const out = new Canvas(WIDTH, HEIGHT);
  const amp = between(rng, 2, 4);
  const period = between(rng, 20, 32);
  const phase = rng() * Math.PI * 2;
  for (let y = 0; y < HEIGHT; y++) {
    const dx = Math.round(amp * Math.sin(y / period + phase));
    for (let x = 0; x < WIDTH; x++) {
      const sx = Math.min(WIDTH - 1, Math.max(0, x + dx));
      const i = (y * WIDTH + sx) * 3;
      out.set(x, y, [base.px[i]!, base.px[i + 1]!, base.px[i + 2]!]);
    }
  }
  return encodePng(out);
}
