import { relicBaseName } from '../warframe/items.js';

/**
 * Free, no-AI question understanding: keyword and pattern rules that map a chat message to one of the
 * bot's existing data lookups. Pure, so it's cheap to test against real-world phrasings.
 */
export type WorldView =
  | 'baro'
  | 'sortie'
  | 'archon'
  | 'steelpath'
  | 'nightwave'
  | 'invasions'
  | 'deals'
  | 'events'
  | 'archimedea'
  | 'resurgence'
  | 'cycles';

export type Intent =
  | { kind: 'help' }
  | { kind: 'price'; item: string }
  | { kind: 'drops'; item: string }
  | { kind: 'relic'; name: string }
  | { kind: 'world'; view: WorldView }
  | { kind: 'fissures'; tier?: string; steelPath?: boolean; storm?: boolean }
  | { kind: 'bounties'; syndicate: string | null }
  | { kind: 'clanEvents' }
  | { kind: 'build'; item: string }
  | { kind: 'item'; name: string }
  | { kind: 'wiki'; query: string };

const SYNDICATES: [RegExp, string][] = [
  [/\b(ostrons?|cetus|konzu|plains)\b/, 'Ostrons'],
  [/\b(solaris|fortuna|vallis|eudico)\b/, 'Solaris United'],
  [/\b(entrati|deimos|necralisk|mother)\b/, 'Entrati'],
  [/\b(holdfasts?|zariman|chrysalith)\b/, 'The Holdfasts'],
  [/\b(cavia|sanctum|albrecht'?s)\b/, 'Cavia'],
  [/\b(hex|h[oö]llvania)\b/, 'The Hex'],
];

const TIERS = ['lith', 'meso', 'neo', 'axi', 'requiem', 'omnia'];

/** Strips filler around an item name: articles, "prime set" stays, trailing "drops"/"from" etc. go. */
export function cleanItem(text: string): string {
  return text
    .replace(/[?!.,]+/g, ' ')
    .replace(/^\s*(?:a|an|the|some|more|my|any)\s+/i, '')
    .replace(/\s+(?:drops?|from|in warframe|on pc|right now|now|today|currently|worth|cost|go for|sell for)\s*$/i, '')
    .replace(/\s+(?:drops?|from)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const first = (q: string, patterns: RegExp[]) => {
  for (const p of patterns) {
    const m = q.match(p);
    if (m?.[1]) {
      const item = cleanItem(m[1]);
      if (item.length >= 2) return item;
    }
  }
  return null;
};

export function detectIntent(raw: string): Intent {
  const q = raw.toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
  if (!q || /^(hi|hey|hello|yo|sup|help|ordis|commands|what can you do|what do you do|how do (?:i|you) use (?:you|this|ordis))\b.{0,20}$/.test(q)) {
    return { kind: 'help' };
  }

  // Prices come first: "how much is a neo n16 relic" is about price, not about the relic's contents.
  if (/\b(price|prices|pricecheck|pc|worth|how much|wtb|wts|plat(?:inum)?|value|sell(?:ing)? for|buy(?:ing)? for)\b/.test(q)) {
    const item = first(q, [
      /(?:price ?check|pc|price (?:of|for)|prices (?:of|for)|value of|worth of)\s+(.+)/,
      /how much (?:plat(?:inum)? )?(?:is|are|does|do|for|would)\s+(?:a |an |the )?(.+?)(?:\s+(?:worth|cost|go for|sell for|sell))?$/,
      /what(?:'s| is| are) (?:the )?(?:price|value|worth)(?: of| for)?\s+(.+)/,
      /what(?:'s| is| are)\s+(.+?)\s+(?:worth|going for|selling for)$/,
      /(?:wtb|wts)\s+(.+)/,
      /^(.+?)\s+(?:price|prices|pc|value|worth)$/,
    ]);
    if (item) return { kind: 'price', item };
  }

  if (/\bbount(?:y|ies)\b/.test(q)) {
    return { kind: 'bounties', syndicate: SYNDICATES.find(([re]) => re.test(q))?.[1] ?? null };
  }

  // "where does X drop", "how do I farm X", "X drop locations", "what drops X"
  const drops = first(q, [
    /what drops\s+(.+)/,
    /(?:drop (?:locations?|chances?|rates?|tables?) (?:of|for)|drop locations? for)\s+(.+)/,
    /where (?:do|does|can|should|to)?\s*(?:i|you|we|one)?\s*(?:get|farm|find|obtain|grind|buy)\s+(.+)/,
    /where (?:does|do|is|are)\s+(.+?)\s+(?:drop|drops|dropping|farmed|found)\b/,
    /how (?:do|can|should|would)?\s*(?:i|you|we|one)?\s*(?:to )?(?:get|farm|find|obtain|grind)\s+(.+)/,
    /^(.+?)\s+(?:drops?|drop locations?|drop chances?|farm(?:ing)?(?: spots?| locations?)?)$/,
    /^(?:farm(?:ing)?|best place to farm)\s+(.+)/,
  ]);
  if (drops) {
    const relic = relicBaseName(drops);
    // Vaulted status and refinement chances are on the relic card, which beats a bare drop list.
    return relic ? { kind: 'relic', name: relic } : { kind: 'drops', item: drops };
  }

  const relicMatch = q.match(/\b(lith|meso|neo|axi|requiem)\s+([a-z]\d+)\b/);
  if (relicMatch) return { kind: 'relic', name: relicBaseName(`${relicMatch[1]} ${relicMatch[2]}`)! };

  if (/\b(?:clan|our|guild)\b.*\bevents?\b|\bnext (?:clan )?(?:event|run|raid)\b|\bevents? (?:are )?(?:planned|scheduled)\b/.test(q)) {
    return { kind: 'clanEvents' };
  }

  if (/\b(?:fissures?|void storms?|relic missions?)\b/.test(q)) {
    return {
      kind: 'fissures',
      tier: TIERS.find((t) => new RegExp(`\\b${t}\\b`).test(q))?.replace(/^./, (c) => c.toUpperCase()),
      steelPath: /\bsteel ?path\b|\bsp\b/.test(q) ? true : undefined,
      storm: /\bstorms?\b|\brailjack\b/.test(q) ? true : undefined,
    };
  }

  const views: [RegExp, WorldView][] = [
    [/\bbaro\b|\bvoid trader\b|\bki'?teer\b/, 'baro'],
    [/\bvarzia\b|\bresurgence\b|\bprime vault\b|\baya\b/, 'resurgence'],
    [/\bsorties?\b/, 'sortie'],
    [/\barchon hunt\b|\barchon\b(?!\s*shards?)/, 'archon'],
    [/\bteshin\b|\bsteel (?:path )?(?:essence|honors|rewards?)\b/, 'steelpath'],
    [/\bnightwave\b|\bnora\b/, 'nightwave'],
    [/\binvasions?\b/, 'invasions'],
    [/\bdarvo\b|\bdaily deal\b|\bdeal of the day\b/, 'deals'],
    [/\barchimedeas?\b/, 'archimedea'],
    [/\b(?:in-?game|current|active|ongoing|running|live)\s+events?\b|\bevents? (?:running|going on|active|live)\b|\bany events?\b/, 'events'],
    [/\b(?:cetus|plains|eidolons?|vallis|fortuna|cambion|fass|vome|zariman|duviri|spiral|cycles?)\b|\bis it (?:day|night|warm|cold)\b|\b(?:day|night)(?: ?time)?\b/, 'cycles'],
  ];
  for (const [re, view] of views) if (re.test(q)) return { kind: 'world', view };

  const build = first(q, [/\b(?:builds?|build guide|modding|mod setup|loadout)\s+(?:for|on)\s+(.+)/, /^(?:how (?:to|do i|should i) )?(?:build|mod)\s+(.+)/, /^(.+?)\s+builds?$/]);
  if (build) return { kind: 'build', item: build };

  const item = first(q, [
    /(?:stats?|statistics|info(?:rmation)?|details?|abilities)\s+(?:of|for|on|about)\s+(.+)/,
    /(?:tell me about|what (?:is|are) the stats of|show me|look ?up)\s+(.+)/,
    /^(.+?)\s+(?:stats?|abilities|info)$/,
  ]);
  if (item) return { kind: 'item', name: item };

  // A bare short phrase ("wisp prime", "condition overload") is most likely an item name.
  const words = q.split(' ');
  if (words.length <= 4 && !/^(what|how|why|when|who|where|is|are|can|does|do|should)\b/.test(q)) {
    return { kind: 'item', name: cleanItem(q) };
  }

  return { kind: 'wiki', query: cleanQuestion(q) };
}

const STOPWORDS = new Set(
  'a an the is are was were be do does did how what why when who where which can could should would i you we me my to of in on for and or with it this that there any about please ordis operator tell explain get got best way work works'.split(' '),
);

/** Keywords for a wiki search: "how do archon shards work?" → "archon shards work". */
export function cleanQuestion(q: string): string {
  const words = q.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  return (words.length ? words : q.split(/\s+/)).slice(0, 8).join(' ');
}
