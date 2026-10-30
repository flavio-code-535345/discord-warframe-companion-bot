const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

const STOP_WORDS = new Set(
  (
    'a an the and or but if so of to in on at by for with from into about as is are was were be been being am do does did done can could ' +
    'should would will shall may might must have has had having i me my mine we our you your he she it its they them their this that these ' +
    'those what whats which who whom whose where when why how there here get got getting give tell show find need want know please ' +
    'any some much many more most just also then than very really ordis operator warframe game ' +
    'type types kind kinds work works way ways thing things use used using mean means meaning difference between best good'
  ).split(' '),
);

/**
 * Word runs of the query, longest first: "archon shards work" → "Archon Shards Work", "Archon Shards", … Punctuation around a
 * word goes ("incarnon?" is "Incarnon"); the list is long enough that a long question still reaches its single words.
 */
export function titleCandidates(query: string, maxWords = 4): string[] {
  const words = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^["'(\[]+|["')\],.!?;:]+$/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (let n = Math.min(maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = titleCase(words.slice(i, i + n).join(' '));
      // A lone filler word ("Types", "What") is never what a question is about, but may sit inside a longer title.
      if (n === 1 && (phrase.length < 4 || STOP_WORDS.has(phrase.toLowerCase()))) continue;
      if (!out.includes(phrase)) out.push(phrase);
      // Wiki pages are mostly singular ("Archon Shard"), with no redirect from every plural.
      const singular = phrase.replace(/s$/, '');
      if (singular !== phrase && singular.length >= 4 && !out.includes(singular)) out.push(singular);
      // ...but some are plural ("Requiem Mods"), so "requiem mod" should find them too.
      if (n > 1 && !phrase.endsWith('s') && !out.includes(`${phrase}s`)) out.push(`${phrase}s`);
    }
  }
  return out.slice(0, 240);
}

/** Words members use for what the wiki calls something else, for picking the section that answers: "reputation" is "standing". */
const SYNONYMS: Record<string, string[]> = {
  reputation: ['standing'],
  rep: ['standing'],
  mr: ['mastery'],
  xp: ['affinity'],
  exp: ['affinity'],
  plat: ['platinum'],
  sp: ['steel', 'path'],
  dmg: ['damage'],
  rotation: ['rotations'],
  nickname: ['username', 'alias'],
  ign: ['username', 'alias'],
  combinations: ['combined', 'combine', 'secondary'],
  combination: ['combined', 'combine', 'secondary'],
  combos: ['combined', 'combine', 'secondary'],
};

/**
 * Category words: a page named only with these ("Syndicate Reputation", "Status Effect") is less what a question is about than
 * a specific name next to them ("Ostron", "Viral").
 */
const GENERIC = new Set(
  (
    'mod mods syndicate syndicates reputation standing rank ranks resource resources mission missions weapon weapons gun guns relic relics ' +
    'arcane arcanes boss bosses quest quests enemy enemies damage status effect effects farm farming platinum clan guide item items reward rewards ' +
    'ability abilities build builds stats primary secondary melee companion companions pet pets blueprint blueprints drop drops point points'
  ).split(' '),
);

/** True when every word of a name is a category word. */
export const isGenericName = (name: string): boolean => name.toLowerCase().split(/\s+/).every((w) => GENERIC.has(w) || isStopWord(w));

export const synonymsOf = (term: string): string[] => (Object.hasOwn(SYNONYMS, term) ? SYNONYMS[term]! : []);

/** The question's terms plus the wiki's words for them. */
export const withSynonyms = (terms: string[]): string[] => [...new Set([...terms, ...terms.flatMap(synonymsOf)])];

export const isStopWord = (word: string): boolean => STOP_WORDS.has(word.toLowerCase());

/** The words of a question that carry meaning: lowercase, deduplicated, without filler. */
export function queryTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
  const seen = new Set<string>();
  for (const w of words) {
    const word = w.replace(/'s$/, '');
    if (word.length >= 2 && !STOP_WORDS.has(word)) seen.add(word);
  }
  return [...seen];
}
