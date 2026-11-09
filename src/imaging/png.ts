import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';

/** A pureimage bitmap as PNG bytes, in memory. */
export async function encodePng(img: ReturnType<typeof PImage.make>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => chunks.push(c));
  await PImage.encodePNGToStream(img, sink);
  return Buffer.concat(chunks);
}
