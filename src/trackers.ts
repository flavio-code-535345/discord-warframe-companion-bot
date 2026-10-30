import { own } from './own.js';
import { type TimeInput, toMs } from './time.js';
import { type WorldState, activeArbitration, isBaroHere, resurgenceItemName, rewardText } from './warframe/worldstate.js';
import { projectCycles } from './warframe/cycles.js';

/**
 * Personal trackers: what a member asked to be DM'd about. Matching is pure (worldstate in, matches out)
 * so the notifier only has to de-duplicate and deliver.
 */
export type TrackerSpec =
  | { kind: 'reward'; keyword: string }
  | { kind: 'fissure'; tier?: string; mission?: string; steelPath?: boolean; storm?: boolean }
  | { kind: 'cycle'; cycle: string; state: string }
  | { kind: 'baro' }
  | { kind: 'arbitration'; type?: string }
  | { kind: 'sortie'; mission?: string }
  | { kind: 'archon' };

export const MAX_TRACKERS_PER_USER = 15;

/** "Cetus night" etc., in the order shown in the slash-command choices. */
export const CYCLE_CHOICES: { label: string; cycle: string; state: string }[] = [
  { label: 'Cetus night', cycle: 'cetus', state: 'night' },
  { label: 'Cetus day', cycle: 'cetus', state: 'day' },
  { label: 'Orb Vallis warm', cycle: 'vallis', state: 'warm' },
  { label: 'Orb Vallis cold', cycle: 'vallis', state: 'cold' },
  { label: 'Cambion Drift Fass', cycle: 'cambion', state: 'fass' },
  { label: 'Cambion Drift Vome', cycle: 'cambion', state: 'vome' },
  { label: 'Zariman Corpus', cycle: 'zariman', state: 'corpus' },
  { label: 'Zariman Grineer', cycle: 'zariman', state: 'grineer' },
  { label: 'Earth day', cycle: 'earth', state: 'day' },
  { label: 'Earth night', cycle: 'earth', state: 'night' },
  ...['joy', 'anger', 'envy', 'sorrow', 'fear'].map((m) => ({ label: `Duviri ${m}`, cycle: 'duviri', state: m })),
];

export const MISSION_TYPES = [
  'Alchemy', 'Assassination', 'Capture', 'Defection', 'Defense', 'Disruption', 'Excavation', 'Extermination',
  'Hijack', 'Hive', 'Infested Salvage', 'Interception', 'Mirror Defense', 'Mobile Defense', 'Orphix', 'Rescue',
  'Sabotage', 'Skirmish', 'Spy', 'Survival', 'Void Armageddon', 'Void Cascade', 'Void Flood', 'Volatile',
];

const MISSION_ALIASES: Record<string, string> = { exterminate: 'extermination', 'mobile defence': 'mobile defense', defence: 'defense' };
const normMission = (m: string) => {
  const s = m.trim().toLowerCase();
  return own(MISSION_ALIASES, s) ?? s;
};

/** Something in the current worldstate a tracker can match. */
export interface Trackable {
  /** Stable identity: the same item keeps its key across polls, a new rotation gets a new one. */
  key: string;
  kind: TrackerSpec['kind'];
  title: string;
  /** Searchable reward text for reward trackers. */
  rewards?: string[];
  detail: string;
  expiry?: TimeInput;
  fissure?: { tier: string; mission: string; steelPath: boolean; storm: boolean };
  cycle?: { cycle: string; state: string };
  arbitration?: { type: string };
  sortie?: { missions: string[] };
}

export function collectTrackables(ws: WorldState, now = Date.now()): Trackable[] {
  const out: Trackable[] = [];
  const live = (e: TimeInput) => toMs(e) > now;

  for (const inv of ws.invasions ?? []) {
    if (inv.completed) continue;
    const sides = inv.vsInfestation ? [inv.defender] : [inv.attacker, inv.defender];
    const rewards = sides.map((s) => rewardText(s.reward)).filter((r) => r !== '—');
    out.push({ key: `invasion:${inv.id}`, kind: 'reward', title: `Invasion on ${inv.node}`, rewards, detail: `${inv.desc}: ${rewards.join(' / ')}` });
  }
  for (const a of ws.alerts ?? []) {
    if (!live(a.expiry)) continue;
    const reward = rewardText(a.mission.reward);
    out.push({ key: `alert:${a.id}`, kind: 'reward', title: `Alert on ${a.mission.node}`, rewards: [reward], detail: `${a.mission.type}: ${reward}`, expiry: a.expiry });
  }
  for (const d of ws.dailyDeals ?? []) {
    if (!live(d.expiry)) continue;
    out.push({ key: `deal:${d.id}`, kind: 'reward', title: "Darvo's deal", rewards: [d.item], detail: `${d.item} for ${d.salePrice}p (-${d.discount}%)`, expiry: d.expiry });
  }
  for (const e of ws.events ?? []) {
    if (!live(e.expiry)) continue;
    const rewards = (e.rewards ?? []).map(rewardText).filter((r) => r !== '—');
    if (rewards.length) out.push({ key: `event:${e.id}`, kind: 'reward', title: e.description, rewards, detail: rewards.join(', '), expiry: e.expiry });
  }
  if (ws.steelPath?.currentReward && live(ws.steelPath.expiry)) {
    const r = ws.steelPath.currentReward;
    out.push({ key: `steelpath:${toMs(ws.steelPath.activation)}`, kind: 'reward', title: 'Steel Path honors', rewards: [r.name], detail: `${r.name} for ${r.cost} Steel Essence`, expiry: ws.steelPath.expiry });
  }
  if (ws.vaultTrader?.inventory?.length && live(ws.vaultTrader.expiry)) {
    const items = ws.vaultTrader.inventory.map((i) => resurgenceItemName(i.item));
    out.push({ key: `resurgence:${toMs(ws.vaultTrader.expiry)}`, kind: 'reward', title: 'Prime Resurgence', rewards: items, detail: 'Varzia', expiry: ws.vaultTrader.expiry });
  }
  if (ws.voidTrader && isBaroHere(ws, now)) {
    const items = ws.voidTrader.inventory.map((i) => i.item);
    const key = `baro:${ws.voidTrader.id}:${toMs(ws.voidTrader.activation)}`;
    out.push({ key, kind: 'baro', title: "Baro Ki'Teer has arrived", detail: `At ${ws.voidTrader.location} with ${items.length} items`, expiry: ws.voidTrader.expiry });
    out.push({ key: `${key}:items`, kind: 'reward', title: "Baro Ki'Teer's inventory", rewards: items, detail: `At ${ws.voidTrader.location}`, expiry: ws.voidTrader.expiry });
  }

  const arb = activeArbitration(ws, now);
  if (arb) {
    const flags = [arb.archwing ? 'Archwing' : '', arb.sharkwing ? 'Sharkwing' : ''].filter(Boolean);
    const type = arb.type ?? 'Unknown';
    out.push({
      key: `arbitration:${toMs(arb.activation)}`,
      kind: 'arbitration',
      title: `Arbitration: ${type}`,
      detail: `${arb.node}${arb.enemy ? ` · ${arb.enemy}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`,
      expiry: arb.expiry,
      arbitration: { type },
    });
  }
  if (ws.sortie && live(ws.sortie.expiry)) {
    const variants = ws.sortie.variants ?? [];
    out.push({
      key: `sortie:${ws.sortie.id}`,
      kind: 'sortie',
      title: `Daily sortie${ws.sortie.boss ? `: ${ws.sortie.boss}` : ''}`,
      detail: variants.map((v) => `${v.missionType} (${v.node})`).join(' · '),
      expiry: ws.sortie.expiry,
      sortie: { missions: variants.map((v) => v.missionType) },
    });
  }
  if (ws.archonHunt && live(ws.archonHunt.expiry)) {
    out.push({
      key: `archon:${ws.archonHunt.id}`,
      kind: 'archon',
      title: `Archon Hunt${ws.archonHunt.boss ? `: ${ws.archonHunt.boss}` : ''}`,
      detail: (ws.archonHunt.missions ?? []).map((m) => `${m.type} (${m.node})`).join(' · '),
      expiry: ws.archonHunt.expiry,
    });
  }
  // The Duviri Circuit's Warframe choices change weekly: a reward tracker such as "Mesa" matches them like any other reward.
  const circuit = (ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined)?.choices?.find((c) => c.category === 'normal')?.choices;
  if (circuit?.length) out.push({ key: `circuit:${circuit.join(',')}`, kind: 'reward', title: 'Duviri Circuit (Warframes)', rewards: circuit, detail: "This week's Circuit choices" });

  for (const f of ws.fissures ?? []) {
    if (!live(f.expiry)) continue;
    out.push({
      key: `fissure:${f.id}`,
      kind: 'fissure',
      title: `${f.tier} ${f.missionType}${f.isHard ? ' (Steel Path)' : ''}${f.isStorm ? ' (Void Storm)' : ''}`,
      detail: `${f.node} · ${f.enemy}`,
      expiry: f.expiry,
      fissure: { tier: f.tier, mission: f.missionType, steelPath: f.isHard, storm: f.isStorm },
    });
  }

  // The fixed-length cycles are rolled forward locally (see warframe/cycles.ts), so a tracker fires on time even when the cached
  // world state is older than a phase; the rest come from the feed as they are.
  let p: ReturnType<typeof projectCycles> | null = null;
  try {
    p = projectCycles(ws, now);
  } catch {
    p = null;
  }
  const cycles: [string, string, string, TimeInput][] = [
    ['cetus', 'Cetus', p ? (p.cetus.isDay ? 'day' : 'night') : ws.cetusCycle?.isDay ? 'day' : 'night', p ? p.cetus.expiry : ws.cetusCycle?.expiry],
    ['vallis', 'Orb Vallis', p ? (p.vallis.isWarm ? 'warm' : 'cold') : ws.vallisCycle?.isWarm ? 'warm' : 'cold', p ? p.vallis.expiry : ws.vallisCycle?.expiry],
    ['cambion', 'Cambion Drift', p ? p.cambion.state : String(ws.cambionCycle?.state ?? ''), p ? p.cambion.expiry : ws.cambionCycle?.expiry],
    ['zariman', 'Zariman', p ? p.zariman.state : String(ws.zarimanCycle?.state ?? ''), p ? p.zariman.expiry : ws.zarimanCycle?.expiry],
    ['earth', 'Earth', p ? (p.earth.isDay ? 'day' : 'night') : ws.earthCycle?.isDay ? 'day' : 'night', p ? p.earth.expiry : ws.earthCycle?.expiry],
    ['duviri', 'Duviri', String(ws.duviriCycle?.state ?? ''), ws.duviriCycle?.expiry],
  ];
  for (const [cycle, name, state, expiry] of cycles) {
    if (!state || !live(expiry)) continue;
    out.push({ key: `cycle:${cycle}:${state}:${Math.round(toMs(expiry) / 60_000) * 60_000}`, kind: 'cycle', title: `${name}: ${state}`, detail: `${name} is now ${state}`, expiry, cycle: { cycle, state: state.toLowerCase() } });
  }
  return out;
}

/** null when `t` doesn't match; otherwise the matching reward rows (empty for non-reward trackers). */
export function matchTracker(spec: TrackerSpec, t: Trackable): string[] | null {
  if (spec.kind !== t.kind) return null;
  switch (spec.kind) {
    case 'reward': {
      const k = spec.keyword.toLowerCase();
      const hits = (t.rewards ?? []).filter((r) => r.toLowerCase().includes(k));
      return hits.length ? hits : null;
    }
    case 'fissure': {
      const f = t.fissure!;
      if (spec.tier && spec.tier.toLowerCase() !== f.tier.toLowerCase()) return null;
      if (spec.mission && normMission(spec.mission) !== normMission(f.mission)) return null;
      if (spec.steelPath !== undefined && spec.steelPath !== f.steelPath) return null;
      if (spec.storm !== undefined && spec.storm !== f.storm) return null;
      return [];
    }
    case 'cycle':
      return t.cycle && t.cycle.cycle === spec.cycle && t.cycle.state === spec.state ? [] : null;
    case 'baro':
      return [];
    case 'arbitration':
      return spec.type && t.arbitration?.type.toLowerCase() !== spec.type.toLowerCase() ? null : [];
    case 'sortie':
      return spec.mission && !t.sortie?.missions.some((m) => normMission(m) === normMission(spec.mission!)) ? null : [];
    case 'archon':
      return [];
  }
}

export function describeTracker(spec: TrackerSpec): string {
  switch (spec.kind) {
    case 'reward':
      return `Reward containing "${spec.keyword}"`;
    case 'fissure': {
      const parts = [spec.tier, spec.mission].filter(Boolean).join(' ') || 'Any';
      const flags = [spec.steelPath === true ? 'Steel Path' : spec.steelPath === false ? 'normal' : null, spec.storm === true ? 'Void Storm' : spec.storm === false ? 'no storms' : null].filter(Boolean);
      return `${parts} fissure${flags.length ? ` (${flags.join(', ')})` : ''}`;
    }
    case 'cycle':
      return CYCLE_CHOICES.find((c) => c.cycle === spec.cycle && c.state === spec.state)?.label ?? `${spec.cycle} ${spec.state}`;
    case 'baro':
      return "Baro Ki'Teer arrives";
    case 'arbitration':
      return `Arbitration${spec.type ? ` (${spec.type})` : ' (any)'}`;
    case 'sortie':
      return spec.mission ? `Daily sortie with ${spec.mission}` : 'Daily sortie (every reset)';
    case 'archon':
      return 'Weekly Archon Hunt';
  }
}

export function parseSpec(json: string): TrackerSpec | null {
  try {
    const spec = JSON.parse(json) as TrackerSpec;
    return spec && typeof spec === 'object' && 'kind' in spec ? spec : null;
  } catch {
    return null;
  }
}
