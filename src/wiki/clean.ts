/** Turns MediaWiki source into plain text and searchable chunks. Pure, so it is tested without the network. */

export interface Chunk {
  section: string;
  body: string;
}

/** Templates that just display one of their arguments (links to game things); every other template is dropped. */
const DISPLAY_TEMPLATES = new Set([
  'faction', 'mod', 'weapon', 'warframe', 'enemy', 'resource', 'planet', 'mission', 'node', 'relic', 'arcane', 'syndicate',
  'tooltip', 'abbr', 'nowrap', 'lang', 'lc', 'uc', 'ucfirst', 'color', 'colour', 'c', 'text', 'plural', 'pluralize', 'dt', 'ability',
  'companion', 'sentinel', 'pet', 'archwing', 'necramech', 'stance', 'augment', 'quest', 'frame', 'item', 'blueprint', 'lore',
  'd', 'm', 'wf', 'w', 'a', 'e', 'r', 'u', 'ep', 'currency',
]);

/**
 * Amount templates: the wiki writes costs and rewards as {{pc|120}} (an icon and a number). Dropped like other templates, they
 * left "it will cost your account ." in the text, so they become "120 Platinum".
 */
const AMOUNT_TEMPLATES: Record<string, string> = { pc: 'Platinum', cc: 'Credits', kc: 'Kuva', sc: 'Standing', ec: 'Endo', dc: 'Ducats', ac: 'Aya', fc: 'Focus', nc: 'Nightwave Cred' };

/** Bump when the cleaning changes: the crawler then cleans every stored page again instead of only the edited ones. */
export const CLEAN_VERSION = 2;

/** Interlanguage link prefixes (`[[de:Eidolon]]`), which are not article text. */
const LANGUAGE_CODES = 'ar|bg|ca|cs|da|de|el|es|fi|fr|he|hu|id|it|ja|ko|nl|no|pl|pt|pt-br|ro|ru|sr|sv|th|tr|uk|vi|zh|zh-hans|zh-hant';

const SKIPPED_SECTIONS = /^(references?|see also|external links?|gallery|media|navigation|notes?|patch history|update history|quotes|videos?|trivia)$/i;
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', times: '×' };

/** Named template fields that hold real prose (an ability's description, a mod's effect…) rather than data. */
const PROSE_FIELDS = new Set(['description', 'desc', 'info', 'text', 'notes', 'note', 'summary', 'effect', 'effects', 'passive', 'overview', 'lore', 'bio']);
const MIN_PROSE = 20;
/** Stands in for a "|" inside a [[link]] while templates are split on their own pipes. */
const LINK_PIPE = '\u0001';

/**
 * Removes `{{ … }}` from the innermost out. Link-like templates keep their display text, and the prose fields of
 * data templates (ability and mod boxes keep their descriptions there) are kept; everything else is dropped.
 */
function stripTemplates(text: string): string {
  text = text.replace(/\[\[[^\]]*\]\]/g, (m) => m.replace(/\|/g, LINK_PIPE));
  // Template parameters ({{{1|}}}) are not content and would break the brace matching below.
  for (let i = 0; i < 4 && /\{\{\{/.test(text); i++) text = text.replace(/\{\{\{[^{}]*\}\}\}/g, '');
  const innermost = /\{\{([^{}]*)\}\}/g;
  let previous: string;
  let guard = 0;
  do {
    previous = text;
    text = text.replace(innermost, (_, inner: string) => {
      const [rawName = '', ...args] = inner.split('|');
      const name = rawName.trim().toLowerCase();
      const unit = Object.hasOwn(AMOUNT_TEMPLATES, name) ? AMOUNT_TEMPLATES[name] : undefined;
      if (unit) {
        const amount = args[0]?.trim();
        return amount && !amount.includes('=') ? `${amount} ${unit}` : unit;
      }
      if (name === 'ver' && args[0]?.trim()) return `Update ${args[0].trim()}`;
      if (DISPLAY_TEMPLATES.has(name)) {
        const positional = args.map((a) => a.trim()).filter((a) => a && !/^[\w ]+=/.test(a));
        return positional.length ? positional[positional.length - 1]! : '';
      }
      const prose: string[] = [];
      for (const arg of args) {
        const named = /^\s*([A-Za-z_ ]+?)\s*=\s*([\s\S]*)$/.exec(arg);
        if (named && PROSE_FIELDS.has(named[1]!.toLowerCase()) && named[2]!.trim().length >= MIN_PROSE) prose.push(named[2]!.trim());
      }
      return prose.length ? `\n${prose.join('\n')}\n` : '';
    });
  } while (text !== previous && ++guard < 12);
  return text.replace(/\{\{|\}\}/g, '').replaceAll(LINK_PIPE, '|');
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Wiki tables become one line per row, cells joined with " · ". */
function flattenTables(text: string): string {
  const out: string[] = [];
  let row: string[] = [];
  let inTable = 0;
  const flush = () => {
    const line = row.map((c) => c.trim()).filter(Boolean).join(' · ');
    if (line) out.push(line);
    row = [];
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('{|')) {
      inTable++;
      continue;
    }
    if (!inTable) {
      out.push(line);
      continue;
    }
    if (t.startsWith('|}')) {
      flush();
      inTable = Math.max(0, inTable - 1);
    } else if (t.startsWith('|-')) flush();
    else if (t.startsWith('|+')) {
      flush();
      out.push(t.slice(2).trim());
    } else if (t.startsWith('|') || t.startsWith('!')) {
      // "| class=x | text || more" : cells split on ||, an attribute prefix is cut at the first remaining |.
      for (const cell of t.slice(1).split(/\|\||!!/)) {
        const bar = cell.indexOf('|');
        row.push(bar >= 0 && /=/.test(cell.slice(0, bar)) ? cell.slice(bar + 1) : cell);
      }
    } else if (t) row.push(t);
  }
  flush();
  return out.join('\n');
}

export function cleanWikitext(source: string): string {
  let t = source.replace(/\r/g, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(ref|gallery|noinclude|references|math|timeline|imagemap|score)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<ref\b[^>]*\/>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, ' ');
  t = stripTemplates(t);
  // Links: files, categories and interlanguage links vanish; [[A|B]] shows B and [[A#B]] shows A.
  t = t.replace(/\[\[(?:file|image|category|media):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, '');
  t = t.replace(new RegExp(`\\[\\[(?:${LANGUAGE_CODES}):[^\\]]*\\]\\]`, 'gi'), '');
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  t = t.replace(/\[\[([^\]#]*)(?:#[^\]]*)?\]\]/g, '$1');
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '');
  t = flattenTables(t);
  t = t.replace(/'{2,5}/g, '');
  t = t.replace(/<\/?[a-z][^>]*>/gi, '');
  t = t.replace(/__[A-Za-z]+__/g, '').replace(/^-{4,}\s*$/gm, '');
  t = decodeEntities(t);
  t = t.replace(/^[*#:;]+\s*/gm, '• ');
  t = t.replace(/^(•\s*)+$/gm, '');
  t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** Splits cleaned text by its `== headings ==` into passages of at most `max` characters. */
export function chunkText(text: string, max = 1000): Chunk[] {
  const chunks: Chunk[] = [];
  let section = 'Introduction';
  let skip = false;
  let parts: string[] = [];
  let size = 0;
  const flush = () => {
    const body = parts.join('\n').trim();
    if (body.length >= 40 && !skip) chunks.push({ section, body });
    parts = [];
    size = 0;
  };
  for (const line of text.split('\n')) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading) {
      flush();
      section = heading[2]!;
      skip = SKIPPED_SECTIONS.test(section);
      continue;
    }
    if (!line.trim()) continue;
    // Very long lines (big table rows) are cut so one chunk never swallows a whole page.
    const piece = line.length > max ? `${line.slice(0, max)}…` : line;
    if (size + piece.length > max && parts.length) flush();
    parts.push(piece);
    size += piece.length + 1;
  }
  flush();
  return chunks;
}

/** Wikitext in, searchable passages out. */
export const chunkWikitext = (source: string): Chunk[] => chunkText(cleanWikitext(source));
