import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { aiToggle } from '../ai/settings.js';

/**
 * Reads one web page as plain text for the agent (`read_web_page`), usually a link that search_web returned. The model chooses the
 * address, so the bot must never be talked into reading its own network: only http(s), only public addresses (checked after DNS,
 * and again on every redirect), a small download, and a short time limit. The text is data for the model, never instructions.
 */

type Fetcher = typeof fetch;
type Resolver = (host: string) => Promise<string[]>;

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
export const PAGE_CHARS = 6_000;

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('::ffff:');
}

const resolveAll: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Throws when the address is not one the bot may read. */
export async function assertPublicUrl(raw: string, resolve: Resolver = resolveAll): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('that is not a valid web address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http and https addresses can be read');
  if (url.username || url.password) throw new Error('addresses with a login are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host) && !host.includes(':')) throw new Error('that address is not on the public internet');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('that address is not on the public internet');
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

/** HTML to readable text: scripts, styles and page furniture dropped, block tags become line breaks, entities decoded. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decode = (s: string): string =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title: decode(title).replace(/\s+/g, ' ').trim().slice(0, 160), text };
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
  /** True when the page was longer than what is returned. */
  cut: boolean;
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

export async function readWebPage(rawUrl: string, opts: { fetcher?: Fetcher; resolve?: Resolver; chars?: number } = {}): Promise<WebPage> {
  if (!aiToggle('websearch')) throw new Error('reading web pages is switched off');
  const fetcher = opts.fetcher ?? fetch;
  let url = await assertPublicUrl(rawUrl, opts.resolve);
  for (let hop = 0; ; hop++) {
    const res = await fetcher(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9', 'User-Agent': 'Mozilla/5.0 (compatible; CephalonOrdis/1.0; Warframe clan bot)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString(), opts.resolve);
      continue;
    }
    if (!res.ok) throw new Error(`the page answered HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (type && !/^(text\/|application\/(json|xhtml|xml))/i.test(type)) throw new Error(`that is not a text page (${type.split(';')[0]})`);
    const raw = await readBody(res);
    const { title, text } = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw.replace(/[ \t]+/g, ' ').trim() };
    if (!text) throw new Error('the page has no readable text');
    const limit = opts.chars ?? PAGE_CHARS;
    return { url: url.toString(), title, text: text.slice(0, limit), cut: text.length > limit };
  }
}
