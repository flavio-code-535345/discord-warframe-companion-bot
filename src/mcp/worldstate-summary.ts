import { type TimeInput, relative, toMs } from '../time.js';
import { type Fissure, type WorldState, isBaroHere, rewardText } from '../warframe/worldstate.js';

export const SECTIONS = ['cycles', 'sortie', 'archon', 'baro', 'steelpath', 'nightwave', 'invasions', 'alerts'] as const;
export type Section = (typeof SECTIONS)[number];

const when = (date: TimeInput, now: number) => {
  const ms = toMs(date);
  return Number.isNaN(ms) ? null : { at: new Date(ms).toISOString(), in: relative(ms, now) };
};

/** Plain-JSON view of the worldstate for AI clients: no Discord markup, explicit ISO times plus "in 2h 5m". */
export function summarizeWorldState(ws: WorldState, sections: readonly Section[] = SECTIONS, now = Date.now()) {
  const out: Record<string, unknown> = { fetchedAt: new Date(now).toISOString() };
  const want = new Set(sections);

  if (want.has('cycles')) {
    const d = ws.duviriCycle;
    out.cycles = {
      cetus: { state: ws.cetusCycle.isDay ? 'day' : 'night', ends: when(ws.cetusCycle.expiry, now) },
      orbVallis: { state: ws.vallisCycle.isWarm ? 'warm' : 'cold', ends: when(ws.vallisCycle.expiry, now) },
      cambionDrift: { state: ws.cambionCycle.state, ends: when(ws.cambionCycle.expiry, now) },
      zariman: { state: ws.zarimanCycle.state, ends: when(ws.zarimanCycle.expiry, now) },
      earth: { state: ws.earthCycle.isDay ? 'day' : 'night', ends: when(ws.earthCycle.expiry, now) },
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
        description: a.mission.description,
        type: a.mission.type,
        node: a.mission.node,
        faction: a.mission.faction,
        reward: rewardText(a.mission.reward),
        ends: when(a.expiry, now),
      }));
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
