/**
 * Real questions from the clan's AI log (and a few common ones), with what a right answer has to say. Used by answers.eval.ts
 * to compare answer pipelines on the live model; not part of `npm test`, because it needs the model and a copy of the wiki.
 *
 * `must`: every pattern has to appear in the answer (text and embeds). `mustNot`: none may appear in the answer text (known
 * wrong answers the bot gave before). `text`: the patterns of `must` that have to be in the written answer itself.
 */
export interface EvalQuestion {
  id: string;
  question: string;
  must?: RegExp[];
  text?: RegExp[];
  mustNot?: RegExp[];
}

export const QUESTIONS: EvalQuestion[] = [
  // Live rotation: answerable exactly from the world state and the wiki's rotation table.
  { id: 'torid-incarnon', question: 'When can I get Torid incarnon next?', text: [/torid/i, /nov(ember)?\s*30|30\s*nov|2026-11-30|<t:1795996800/i], mustNot: [/cambion|fass|vome|zariman/i] },
  { id: 'strun-incarnon', question: 'Whens the next time I can farm Strun incarnon? since its a weekly rotation?', text: [/strun/i, /nov(ember)?\s*16|16\s*nov|2026-11-16|<t:1794787200/i] },
  { id: 'circuit-week', question: "what incarnons are in the steel path circuit this week?", text: [/vectis/i, /stug/i, /ballistica/i, /destreza/i, /obex/i] },

  // Acquisition and farming.
  { id: 'bite', question: 'where do I get the mod bite from?', text: [/kubrow/i] },
  { id: 'kuva-farm', question: 'Whats the best kuva farm?', text: [/kuva (survival|flood)/i] },
  { id: 'endo-farm', question: 'Whats the best endo farm?', text: [/arbitration|rathuum|ayatan|sanctuary onslaught|endo/i] },
  { id: 'steel-essence', question: 'Whats the best steel essence farm?', text: [/acolyte/i] },
  { id: 'tellurium', question: 'what is the best farm for Tellurium?', text: [/uranus/i] },
  { id: 'kubrow-farm', question: 'Where do I farm Feral Kubrows the best?', text: [/earth|grineer forest/i] },
  { id: 'wisp', question: 'How do I get Wisp?', text: [/ropalolyst/i] },
  { id: 'rhino', question: 'how do i get rhino', text: [/jackal|fossa/i] },
  { id: 'mastery-points', question: 'How do I get mastery points?', text: [/rank/i, /\b(100|200)\b/] , mustNot: [/completing (missions|quests|challenges)\b(?![^.]*first)/i] },
  { id: 'credits', question: 'how do i gather credits', text: [/index|profit.?taker|credit cache|booster/i] },
  { id: 'ostron-rep', question: 'how do i gather ostron syndicate reputation', text: [/bount/i] },
  { id: 'steel-path-unlock', question: 'how to unlock Steel path', text: [/star chart|node/i] },
  { id: 'venus', question: 'how do i unlock venus?', text: [/junction/i] },
  { id: 'icebind', question: 'how can I access ice bind', text: [/melica/i] },

  // Mechanics and how-tos.
  { id: 'viral', question: 'How do I gain the viral status effect on my guns', text: [/cold/i, /toxin/i], mustNot: [/(equip|apply|use) (a |the )?\*{0,2}viral\*{0,2} mod/i] },
  { id: 'combos', question: 'Give me all damage variations combinations', text: [/blast/i, /corrosive/i, /gas/i, /magnetic/i, /radiation/i, /viral/i] },
  { id: 'forma', question: 'how to I forma a weapon', text: [/polari[sz]/i] },
  { id: 'dojo', question: 'how to i enter the Clan dojo', text: [/star chart|navigation|relay/i], mustNot: [/\/clan\b/] },
  { id: 'nickname', question: 'How do I change my nickname?', text: [/website/i], mustNot: [/system menu|\b100 platinum/i] },
  { id: 'kuva-lich', question: 'how do i kill a kuva lich', text: [/requiem/i] },
  { id: 'archon-shards', question: 'how do archon shards work', text: [/helminth/i] },
  { id: 'helminth', question: 'what is the helminth', text: [/subsume|infested|ability/i] },
  { id: 'arcane', question: 'what does arcane energize do', text: [/energy/i] },
  { id: 'zarr-riven', question: 'What are the best stats for a Zarr riven?', text: [/critical damage/i, /multishot|critical chance/i] },

  // Plain arithmetic and small talk: no wiki, no invented facts.
  { id: 'math', question: 'what is 9 x 2', text: [/\b18\b/] },
  // Chatter must not turn into a wiki lecture: no numbers, no bolded game names (the old answers offered Aoi, Kaya and "912 Ren Hypercore").
  { id: 'smalltalk-insult', question: 'this clanka dumb af', mustNot: [/clantech|dojo|lato|beta/i, /\d/, /\*\*/] },
  { id: 'smalltalk-gif', question: 'https://klipy.com/gifs/clanker-kylo-ren', mustNot: [/archives|wiki/i, /\d/, /\*\*/] },
];
