import { type TimeInput, relative, toMs } from '../time.js';
import {
  type Fissure,
  type WorldState,
  alertName,
  archimedeaName,
  bountyStanding,
  isBaroHere,
  resurgenceItemName,
  rewardText,
  worldStateStaleNote,
} from '../warframe/worldstate.js';
import { projectCycles } from '../warframe/cycles.js';

export const SECTIONS = [
  'cycles',
  'sortie',
  'archon',
  'baro',
  'steelpath',
  'nightwave',
  'invasions',
  'alerts',
  'deals',
  'events',
  'archimedea',
  'bounties',
  'resurgence',
] as const;
export type Section = (typeof SECTIONS)[number];
/** Sections returned when none are requested; bounties and resurgence stock are long, so they're opt-in. */
export const DEFAULT_SECTIONS: readonly Section[] = SECTIONS.filter((s) => s !== 'bounties' && s !== 'resurgence');

const when = (date: TimeInput, now: number) => {
  const ms = toMs(date);
  return Number.isNaN(ms) ? null : { at: new Date(ms).toISOString(), in: relative(ms, now) };
};

/**
 * Plain-JSON view of the worldstate for AI clients: no Discord markup, explicit ISO times plus "in 2h 5m". A section the feed
 * delivered malformed is left out and named in `unavailable`; the other sections are still answered.
 */
export function summarizeWorldState(ws: WorldState, sections: readonly Section[] = SECTIONS, now = Date.now()) {
  const out: Record<string, unknown> = { fetchedAt: new Date(now).toISOString() };
  const stale = worldStateStaleNote(now);
  if (stale) out.warning = stale;
  const unavailable: string[] = [];
  for (const section of new Set(sections)) {
    try {
      Object.assign(out, summarizeSection(ws, section, now));
    } catch {
      unavailable.push(section);
    }
  }
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}

function summarizeSection(ws: WorldState, section: Section, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const want = new Set<Section>([section]);

  if (want.has('cycles')) {
    const d = ws.duviriCycle;
    const p = projectCycles(ws, now);
    out.cycles = {
      cetus: { state: p.cetus.isDay ? 'day' : 'night', ends: when(p.cetus.expiry, now), ...(p.cetus.projected ? { calculated: true } : {}) },
      orbVallis: { state: p.vallis.isWarm ? 'warm' : 'cold', ends: when(p.vallis.expiry, now), ...(p.vallis.projected ? { calculated: true } : {}) },
      cambionDrift: { state: p.cambion.state, ends: when(p.cambion.expiry, now), ...(p.cambion.projected ? { calculated: true } : {}) },
      zariman: { state: p.zariman.state, ends: when(p.zariman.expiry, now), ...(p.zariman.projected ? { calculated: true } : {}) },
      earth: { state: p.earth.isDay ? 'day' : 'night', ends: when(p.earth.expiry, now), ...(p.earth.projected ? { calculated: true } : {}) },
      duviri: {
        state: d.state,
        ends: when(d.expiry, now),
        circuitWarframes: d.choices?.find((c) => c.category === 'normal')?.choices ?? [],
        steelPathCircuitWeapons: d.choices?.find((c) => c.category === 'hard')?.choices ?? [],
      },
    };
  }

  if (want.has('sortie') && ws.sortie) {
    out.sortie = {
      boss: ws.sortie.boss,
      faction: ws.sortie.faction,
      resets: when(ws.sortie.expiry, now),
      missions: ws.sortie.variants.map((v) => ({ type: v.missionType, node: v.node, modifier: v.modifier })),
    };
  }

  if (want.has('archon') && ws.archonHunt) {
    out.archonHunt = {
      boss: ws.archonHunt.boss,
      resets: when(ws.archonHunt.expiry, now),
      missions: ws.archonHunt.missions.map((m) => ({ type: m.type, node: m.node })),
    };
  }

  if (want.has('baro') && ws.voidTrader) {
    const t = ws.voidTrader;
    const here = isBaroHere(ws, now);
    out.baro = here
      ? { here, location: t.location, leaves: when(t.expiry, now), inventory: t.inventory.map((i) => ({ item: i.item, ducats: i.ducats, credits: i.credits })) }
      : { here, location: t.location, arrives: when(t.activation, now) };
  }

  if (want.has('steelpath') && ws.steelPath) {
    out.steelPath = {
      currentReward: ws.steelPath.currentReward,
      rotates: when(ws.steelPath.expiry, now),
      rotation: ws.steelPath.rotation,
    };
  }

  if (want.has('nightwave') && ws.nightwave) {
    out.nightwave = {
      season: ws.nightwave.season,
      ends: when(ws.nightwave.expiry, now),
      challenges: ws.nightwave.activeChallenges.map((c) => ({
        title: c.title,
        description: c.desc,
        kind: c.isDaily ? 'daily' : c.isElite ? 'elite weekly' : 'weekly',
        reputation: c.reputation,
        ends: when(c.expiry, now),
      })),
    };
  }

  if (want.has('invasions')) {
    out.invasions = ws.invasions
      .filter((i) => !i.completed)
      .map((i) => ({
        node: i.node,
        description: i.desc,
        attacker: { faction: i.attacker.faction, reward: i.vsInfestation ? null : rewardText(i.attacker.reward) },
        defender: { faction: i.defender.faction, reward: rewardText(i.defender.reward) },
        completionPercent: Math.round(i.completion),
      }));
  }

  if (want.has('alerts')) {
    out.alerts = (ws.alerts ?? [])
      .filter((a) => toMs(a.expiry) > now)
      .map((a) => ({
        description: alertName(a),
        type: a.mission.type,
        node: a.mission.node,
        faction: a.mission.faction,
        reward: rewardText(a.mission.reward),
        ends: when(a.expiry, now),
      }));
  }

  if (want.has('deals')) {
    out.darvoDeal = (ws.dailyDeals ?? []).map((d) => ({
      item: d.item,
      salePrice: d.salePrice,
      originalPrice: d.originalPrice,
      discountPercent: d.discount,
      remaining: d.total - d.sold,
      ends: when(d.expiry, now),
    }))[0] ?? null;
  }

  if (want.has('events')) {
    out.events = (ws.events ?? [])
      .filter((e) => toMs(e.expiry) > now)
      .map((e) => ({
        description: e.description,
        node: e.node ?? null,
        progressPercent: e.maximumScore > 1 ? Math.round((e.currentScore / e.maximumScore) * 100) : null,
        rewards: (e.rewards ?? []).map(rewardText).filter((r) => r !== '—'),
        ends: when(e.expiry, now),
      }));
  }

  if (want.has('archimedea')) {
    out.archimedea = (ws.archimedeas ?? []).map((a) => ({
      name: archimedeaName(a.type),
      resets: when((a as unknown as { expiry?: Date }).expiry, now),
      missions: a.missions.map((m) => ({
        type: m.missionType,
        faction: m.faction,
        deviation: m.deviation?.name ?? null,
        risks: (m.risks ?? []).map((r) => r.name),
      })),
      personalModifiers: (a.personalModifiers ?? []).map((p) => p.name),
    }));
  }

  if (want.has('bounties')) {
    out.bounties = (ws.syndicateMissions ?? [])
      .filter((m) => m.jobs?.length)
      .map((m) => ({
        syndicate: m.syndicate,
        rotates: when(m.expiry, now),
        jobs: m.jobs.map((j) => ({
          type: j.type ?? null,
          enemyLevels: j.enemyLevels,
          totalStanding: bountyStanding(j.standingStages),
          minMR: j.minMR || null,
          rewardPool: [...new Set(j.rewardPool ?? [])],
        })),
      }));
  }

  if (want.has('resurgence') && ws.vaultTrader) {
    out.primeResurgence = {
      rotates: when(ws.vaultTrader.expiry, now),
      items: (ws.vaultTrader.inventory ?? []).map((i) => ({ item: resurgenceItemName(i.item), aya: i.ducats || null })),
    };
  }

  return out;
}

export function summarizeFissures(fissures: Fissure[], now = Date.now()) {
  return fissures.map((f) => ({
    tier: f.tier,
    missionType: f.missionType,
    node: f.node,
    enemy: f.enemy,
    steelPath: f.isHard,
    voidStorm: f.isStorm,
    ends: when(f.expiry, now),
  }));
}
