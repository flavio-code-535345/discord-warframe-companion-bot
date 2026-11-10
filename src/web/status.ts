import type { AppContext } from '../context.js';
import { type EmojiName, cycleEmojiName, emojiUrl } from '../discord/emoji.js';
import { getWikiIndex } from '../wiki/index.js';
import { type ArbitrationData, type ArbitrationSlot, type ArbyTier, TIER_HINT, arbitrationView, lastArbitrations } from '../warframe/arbitrations.js';
import { projectCycles } from '../warframe/cycles.js';
import { own } from '../own.js';
import { formatDuration, relative, toMs } from '../time.js';
import { STATUS_CSS } from './theme.js';
import {
  FISSURE_TIERS,
  isNotableReward,
  type WorldState,
  archimedeaName,
  getWorldState,
  groupAlerts,
  worldStateInfo,
  SOURCE_LAG_MS,
  isBaroHere,
  resurgenceItemName,
  rewardText,
} from '../warframe/worldstate.js';

export interface CycleStatus {
  name: string;
  state: string;
  icon: string;
  /** The Warframe emoji for the state (rendered as a picture when the clan's emojis are known), else `icon` is shown. */
  emoji?: EmojiName | undefined;
  endsAt: string | null;
  note?: string;
}

/** Compact world-state digest for the dashboard tiles (and /status.json). Every part is optional. */
export interface WorldTiles {
  sortie: { boss: string; faction: string; endsAt: string | null; missions: { type: string; node: string; modifier: string }[] } | null;
  archon: { boss: string; endsAt: string | null; missions: { type: string; node: string }[] } | null;
  baro: { here: boolean; location: string; at: string | null; items: { name: string; ducats: number }[] } | null;
  steelPath: { current: string; cost: number; next: string | null; endsAt: string | null } | null;
  darvo: { item: string; price: number; original: number; discount: number; left: number; total: number; endsAt: string | null } | null;
  fissures: { tier: string; normal: number; steelPath: number; storm: number }[];
  invasions: { node: string; rewards: string; completion: number; notable: boolean }[];
  events: { name: string; progress: number | null; endsAt: string | null; rewards: string }[];
  archimedea: { name: string; endsAt: string | null; missions: string[] }[];
  nightwave: { season: number; endsAt: string | null; challenges: { title: string; kind: string; reputation: number }[] } | null;
  resurgence: { endsAt: string | null; items: string[] } | null;
  /** Alerts for display (`groupAlerts`): an event's resource missions are one group; `where` is "Type · Node" per mission. */
  alerts: { name: string; count: number; where: string[]; reward: string; notable: boolean; endsAt: string | null }[];
  /** Every open fissure (at most 100), for the page's filters. */
  fissureList: { tier: string; mission: string; node: string; enemy: string; steelPath: boolean; storm: boolean; endsAt: string | null }[];
}

export interface StatusData {
  botName: string;
  clanName: string;
  online: boolean;
  pingMs: number | null;
  uptimeSeconds: number;
  server: { name: string; memberCount: number } | null;
  registeredMembers: number;
  /** The knowledge archive Ordis answers questions from; null when it is switched off. */
  archive: { pages: number; total: number | null; syncing: boolean } | null;
  /** Calls to the world state source (warframestat.us): whether they are on, when the last one was and how it went. */
  warframeApi: { enabled: boolean; intervalSeconds: number; lastCallAt: string | null; lastOk: boolean | null; lastDetail: string | null; smart?: boolean; maxMinutes?: number; nextCallAt?: string | null; sourceLagMinutes?: number | null };
  upcomingEvents: { id: number; title: string; startsAt: string; going: number; maybe: number }[];
  /** null when the worldstate could not be loaded. */
  cycles: CycleStatus[] | null;
  world: WorldTiles | null;
  /** From the Arbitration schedule, so it is there while the world state is not; null when neither knows the current hour. */
  arbitration: ArbitrationStatus | null;
  generatedAt: string;
}

export interface ArbitrationHour {
  tier: ArbyTier;
  /** "Casta" */
  node: string;
  planet: string;
  mission: string;
  faction: string;
  startsAt: string;
  endsAt: string;
}

export interface ArbitrationStatus {
  now: ArbitrationHour | null;
  /** The next hours, in order. */
  next: ArbitrationHour[];
  /** The S and A tier hours of the next 7 days. */
  best: ArbitrationHour[];
  /** False when the schedule and the game disagree: then only `now` (from the world state) is known. */
  trusted: boolean;
}

const NEXT_HOURS = 6;
const BEST_SHOWN = 8;

function arbitrationOf(data: ArbitrationData | null, ws: WorldState | null, now: number): ArbitrationStatus | null {
  const view = arbitrationView(data, ws, now, { hours: NEXT_HOURS + 1, bestDays: 7, bestTier: 'A' });
  if (!view.current && !view.upcoming.length) return null;
  const hour = (s: ArbitrationSlot): ArbitrationHour => ({
    tier: s.tier,
    node: s.name,
    planet: s.planet,
    mission: s.mission,
    faction: s.faction,
    startsAt: new Date(s.start).toISOString(),
    endsAt: new Date(s.end).toISOString(),
  });
  return {
    now: view.current ? hour(view.current) : null,
    next: view.upcoming.slice(0, NEXT_HOURS).map(hour),
    best: view.best.slice(0, BEST_SHOWN).map(hour),
    trusted: view.scheduleTrusted,
  };
}

const ICONS: Record<string, string> = {
  day: '☀️', night: '🌙', warm: '🔥', cold: '❄️', fass: '🟠', vome: '🔵', corpus: '🔷', grineer: '🔶',
  joy: '😊', anger: '😠', envy: '💚', sorrow: '😢', fear: '😨',
};

/** ISO text of a time, or null when it is missing or beyond what a Date can represent (toISOString() throws for those). */
const iso = (d: Date | string | number | undefined | null): string | null => {
  const t = new Date(toMs(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

function cyclesOf(ws: WorldState, now = Date.now()): CycleStatus[] {
  const p = projectCycles(ws, now);
  const cycle = (name: string, key: string, expiry: Date | string | number | undefined, extra: { suffix?: string; note?: string } = {}): CycleStatus => ({
    name,
    state: key.charAt(0).toUpperCase() + key.slice(1) + (extra.suffix ?? ''),
    icon: own(ICONS, key.toLowerCase()) ?? '◆',
    emoji: cycleEmojiName(key),
    endsAt: iso(expiry),
    note: extra.note,
  });
  const circuit = ws.duviriCycle.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  return [
    cycle('Cetus', p.cetus.isDay ? 'day' : 'night', p.cetus.expiry),
    cycle('Orb Vallis', p.vallis.isWarm ? 'warm' : 'cold', p.vallis.expiry),
    cycle('Cambion Drift', p.cambion.state, p.cambion.expiry),
    cycle('Zariman', p.zariman.state, p.zariman.expiry, { suffix: ' control' }),
    cycle('Earth', p.earth.isDay ? 'day' : 'night', p.earth.expiry),
    cycle('Duviri', p.duviri?.state ?? ws.duviriCycle.state, p.duviri?.expiry ?? ws.duviriCycle.expiry, { note: circuit.length ? `Circuit: ${circuit.join(', ')}` : undefined }),
  ];
}

/** Each part is read defensively: one malformed section must not blank the whole page. */
function worldOf(ws: WorldState, now = Date.now()): WorldTiles {
  const live = (d: Date | string | undefined) => toMs(d) > now;
  // The feed is someone else's JSON: what the page writes as a number is made one here (anything else becomes 0).
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const part = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  return {
    sortie: part(() => {
      const s = ws.sortie;
      return s && live(s.expiry)
        ? { boss: s.boss ?? '', faction: s.faction ?? '', endsAt: iso(s.expiry), missions: s.variants.map((v) => ({ type: v.missionType, node: v.node, modifier: v.modifier })) }
        : null;
    }, null),
    archon: part(() => {
      const a = ws.archonHunt;
      return a && live(a.expiry) ? { boss: a.boss ?? '', endsAt: iso(a.expiry), missions: a.missions.map((m) => ({ type: m.type, node: m.node })) } : null;
    }, null),
    baro: part(() => {
      const t = ws.voidTrader;
      if (!t) return null;
      const here = isBaroHere(ws, now);
      return {
        here,
        location: t.location ?? '',
        at: iso(here ? t.expiry : t.activation),
        items: here ? [...(t.inventory ?? [])].sort((x, y) => num(y.ducats) - num(x.ducats)).map((i) => ({ name: i.item, ducats: num(i.ducats) })) : [],
      };
    }, null),
    steelPath: part(() => {
      const sp = ws.steelPath;
      if (!sp?.currentReward) return null;
      const rot = sp.rotation ?? [];
      const idx = rot.findIndex((r) => r.name === sp.currentReward!.name);
      return { current: sp.currentReward.name, cost: num(sp.currentReward.cost), next: idx >= 0 ? (rot[(idx + 1) % rot.length]?.name ?? null) : null, endsAt: iso(sp.expiry) };
    }, null),
    darvo: part(() => {
      const d = ws.dailyDeals?.find((x) => live(x.expiry));
      return d ? { item: d.item, price: num(d.salePrice), original: num(d.originalPrice), discount: num(d.discount), left: num(d.total) - num(d.sold), total: num(d.total), endsAt: iso(d.expiry) } : null;
    }, null),
    fissures: part(
      () =>
        FISSURE_TIERS.map((tier) => {
          const list = (ws.fissures ?? []).filter((f) => f.tier === tier && live(f.expiry));
          return { tier, normal: list.filter((f) => !f.isHard && !f.isStorm).length, steelPath: list.filter((f) => f.isHard).length, storm: list.filter((f) => f.isStorm).length };
        }).filter((r) => r.normal + r.steelPath + r.storm > 0),
      [],
    ),
    invasions: part(
      () =>
        (ws.invasions ?? [])
          .filter((i) => !i.completed)
          .map((i) => {
            const rewards = (i.vsInfestation ? [i.defender] : [i.attacker, i.defender]).map((side) => rewardText(side.reward)).filter((r) => r !== '—').join(' / ');
            return { node: i.node, rewards, completion: Math.round(num(i.completion)), notable: isNotableReward(rewards) };
          })
          .sort((a, b) => Number(b.notable) - Number(a.notable)),
      [],
    ),
    events: part(
      () =>
        (ws.events ?? [])
          .filter((ev) => live(ev.expiry))
          .map((ev) => ({
            name: ev.description,
            progress: num(ev.maximumScore) > 1 ? Math.round((num(ev.currentScore) / num(ev.maximumScore)) * 100) : null,
            endsAt: iso(ev.expiry),
            rewards: (ev.rewards ?? []).map(rewardText).filter((r) => r !== '—').join(', '),
          })),
      [],
    ),
    archimedea: part(
      () =>
        (ws.archimedeas ?? []).map((a) => ({
          name: archimedeaName(a.type),
          endsAt: iso((a as unknown as { expiry?: Date }).expiry),
          missions: a.missions.map((m) => `${m.missionType}${m.deviation?.name ? ` (${m.deviation.name})` : ''}`),
        })),
      [],
    ),
    nightwave: part(() => {
      const nw = ws.nightwave;
      if (!nw) return null;
      return {
        season: num(nw.season),
        endsAt: iso(nw.expiry),
        challenges: [...nw.activeChallenges]
          .sort((a, b) => Number(b.isDaily) - Number(a.isDaily) || Number(a.isElite) - Number(b.isElite))
          .map((c) => ({ title: c.title, kind: c.isDaily ? 'daily' : c.isElite ? 'elite' : 'weekly', reputation: num(c.reputation) })),
      };
    }, null),
    resurgence: part(() => {
      const v = ws.vaultTrader;
      return v?.inventory?.length && live(v.expiry) ? { endsAt: iso(v.expiry), items: v.inventory.map((i) => resurgenceItemName(i.item)) } : null;
    }, null),
    alerts: part(
      () =>
        groupAlerts((ws.alerts ?? []).filter((a) => live(a.expiry))).map((g) => ({
          name: g.name,
          count: g.alerts.length,
          where: g.alerts.map((a) => [a.mission.type, a.mission.node].filter(Boolean).join(' · ')),
          reward: g.reward,
          notable: g.notable,
          endsAt: iso(g.alerts[0]!.expiry),
        })),
      [],
    ),
    fissureList: part(() => {
      const order = (tier: string) => (FISSURE_TIERS as readonly string[]).indexOf(tier) + 1 || 99;
      return (ws.fissures ?? [])
        .filter((f) => live(f.expiry))
        .sort((a, b) => order(a.tier) - order(b.tier) || toMs(a.expiry) - toMs(b.expiry))
        .slice(0, 100)
        .map((f) => ({ tier: f.tier, mission: f.missionType ?? '', node: f.node ?? '', enemy: f.enemy ?? '', steelPath: !!f.isHard, storm: !!f.isStorm, endsAt: iso(f.expiry) }));
    }, []),
  };
}

/** One line about the world state source: off, or when it was last called and how that went (the status footer, the panel's overview). */
export function worldStateLine(a: StatusData['warframeApi']): string {
  if (!a.enabled) return 'off';
  const cadence = a.smart ? `smart, at least every ${a.maxMinutes} min` : `every ${Math.round(a.intervalSeconds / 60)} min`;
  if (!a.lastCallAt) return `not called yet · ${cadence}`;
  const ago = formatDuration(Math.max(0, Date.now() - Date.parse(a.lastCallAt)));
  const behind = a.sourceLagMinutes ? ` · source data ${a.sourceLagMinutes} min behind` : '';
  return `last call ${ago} ago · ${a.lastOk ? 'ok' : (a.lastDetail ?? 'failed').replace(/^Worldstate request failed: /, '')} · ${cadence}${behind}`;
}

function archiveProgress(): StatusData['archive'] {
  const index = getWikiIndex();
  if (!index) return null;
  const total = Number(index.getMeta('total') ?? 0);
  return { pages: index.stats().pages, total: total || null, syncing: index.getMeta('syncing') === '1' };
}

function warframeApiStatus(): StatusData['warframeApi'] {
  const i = worldStateInfo();
  return {
    enabled: i.enabled,
    intervalSeconds: i.intervalSeconds,
    lastCallAt: i.lastCallAt === null ? null : new Date(i.lastCallAt).toISOString(),
    lastOk: i.lastOk,
    lastDetail: i.lastDetail,
    smart: i.smart,
    maxMinutes: i.maxMinutes,
    nextCallAt: i.nextCallAt === null ? null : new Date(i.nextCallAt).toISOString(),
    sourceLagMinutes: i.sourceLagMs !== null && i.sourceLagMs > SOURCE_LAG_MS ? Math.round(i.sourceLagMs / 60_000) : null,
  };
}

/**
 * Collects everything the public status page shows. Uses only cached Discord data, the paced world state and the Arbitration
 * schedule the world-state job read last (`lastArbitrations`, no request), so page views cost no API calls. The tests pass their
 * own loaders.
 */
export async function buildStatus(
  ctx: AppContext,
  loadWorldState: () => Promise<WorldState> = getWorldState,
  loadArbitrations: () => ArbitrationData | null = lastArbitrations,
): Promise<StatusData> {
  const { client, config, store } = ctx;
  const online = client.isReady();
  const guild = online ? client.guilds.cache.get(config.DISCORD_GUILD_ID) : undefined;
  const ping = online ? client.ws.ping : -1;

  let cycles: CycleStatus[] | null = null;
  let world: WorldTiles | null = null;
  let ws: WorldState | null = null;
  try {
    ws = await loadWorldState();
    // Each part on its own: a feed that lacks one cycle must not take the sortie, the fissures and the rest of the page down with it.
    try {
      cycles = cyclesOf(ws);
    } catch {
      // The cycles tile shows as unavailable.
    }
    try {
      world = worldOf(ws);
    } catch {
      // The other tiles show as unavailable.
    }
  } catch {
    // The notifier already logs worldstate failures; the page just shows those tiles as unavailable.
  }
  let arbitration: ArbitrationStatus | null = null;
  try {
    arbitration = arbitrationOf(loadArbitrations(), ws, Date.now());
  } catch {
    // The tile says the schedule can't be read.
  }

  return {
    botName: config.BOT_NAME,
    clanName: config.CLAN_NAME,
    online,
    pingMs: ping >= 0 ? ping : null,
    uptimeSeconds: Math.floor(process.uptime()),
    server: guild ? { name: guild.name, memberCount: guild.memberCount } : null,
    registeredMembers: store.listMembers(config.DISCORD_GUILD_ID).length,
    archive: archiveProgress(),
    warframeApi: warframeApiStatus(),
    // Titles and counts only: who RSVP'd stays inside Discord.
    upcomingEvents: store
      .upcomingEvents(config.DISCORD_GUILD_ID)
      .slice(0, 8)
      .flatMap((e) => {
        const startsAt = iso(e.startsAt);
        if (!startsAt) return [];
        const r = store.getRsvps(e.id);
        return [{ id: e.id, title: e.title, startsAt, going: r.going.length, maybe: r.maybe.length }];
      }),
    cycles,
    world,
    arbitration,
    generatedAt: new Date().toISOString(),
  };
}

/** Escapes text for HTML. Takes anything: a value that should have been text (a number or nothing from a feed) is written as text, never thrown on. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Server-side fallback text; the page script replaces it with the reader's local time (`data-local`, or `data-local="t"` for the clock only). */
const utc = (isoTime: string) => `${new Date(isoTime).toUTCString().slice(0, 22)} UTC`;
const utcClock = (isoTime: string) => `${isoTime.slice(11, 16)} UTC`;

const countdown = (isoTime: string | null) =>
  isoTime ? `<span class="cd" data-until="${isoTime}">${escapeHtml(relative(isoTime))}</span>` : '<span class="cd">—</span>';

const SCRIPT = `
const fmt=ms=>{const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return d?d+'d '+h+'h':h?h+'h '+m+'m':m?m+'m '+s+'s':s+'s'};
const local=new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),clock=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'});
let kind='all',tier='all',last=Date.now(),busy=false;
try{const s=JSON.parse(sessionStorage.getItem('fissures')||'{}');kind=s.kind||'all';tier=s.tier||'all'}catch(e){}
function localize(){document.querySelectorAll('time[data-local]').forEach(t=>{t.textContent=(t.dataset.local==='t'?clock:local).format(new Date(t.dateTime))})}
function filt(){
document.querySelectorAll('.chip').forEach(c=>{const on=c.dataset.kind!==undefined?c.dataset.kind===kind:c.dataset.tier===tier;c.classList.toggle('on',on)});
let n=0;document.querySelectorAll('tr[data-tier]').forEach(r=>{const show=(kind==='all'||r.dataset.kind===kind)&&(tier==='all'||r.dataset.tier===tier);r.hidden=!show;if(show)n++});
const c=document.querySelector('[data-fcount]');if(c)c.textContent=n+' shown'}
document.addEventListener('click',e=>{const c=e.target.closest&&e.target.closest('.chip');if(!c)return;if(c.dataset.kind!==undefined)kind=c.dataset.kind;else tier=c.dataset.tier;try{sessionStorage.setItem('fissures',JSON.stringify({kind:kind,tier:tier}))}catch(x){}filt()});
async function refresh(){if(busy)return;busy=true;try{const r=await fetch('/',{cache:'no-store'});if(r.ok){const m=new DOMParser().parseFromString(await r.text(),'text/html').querySelector('main');if(m){const o=[...document.querySelectorAll('details[data-g]')].map(d=>[d.dataset.g,d.open]);document.querySelector('main').innerHTML=m.innerHTML;o.forEach(([g,v])=>{document.querySelectorAll('details[data-g]').forEach(d=>{if(d.dataset.g===g)d.open=v})});localize();filt()}}}catch(e){}last=Date.now();busy=false}
function tick(){const now=Date.now();let over=false;document.querySelectorAll('[data-until]').forEach(el=>{const left=Date.parse(el.dataset.until)-now;el.textContent=left>0?'in '+fmt(left):'now';if(left<=0)over=true});if(over&&now-last>15000)refresh()}
localize();filt();tick();setInterval(tick,1000);setInterval(refresh,60000);
`;

/** A Warframe icon for the page: the clan's custom emoji on Discord's CDN, or null when only a Unicode stand-in exists. */
export type IconLookup = (name: EmojiName) => string | null;

const RELIC_ICON: Record<string, EmojiName> = { Lith: 'lith', Meso: 'meso', Neo: 'neo', Axi: 'axi', Requiem: 'requiem', Omnia: 'omnia' };

export function renderStatusPage(s: StatusData, nonce: string, iconOf: IconLookup = (name) => emojiUrl(name, 48)): string {
  const e = escapeHtml;
  const w = s.world;
  const icon = (name: EmojiName | undefined): string => {
    const url = name ? iconOf(name) : null;
    return url ? `<img class="ico" src="${e(url)}" alt="" width="18" height="18" loading="lazy">` : '';
  };
  const row = (k: string, v = '', note = '') => `<div class="r"><span class="k">${k}${note ? `<span class="n">${note}</span>` : ''}</span><span class="v">${v}</span></div>`;
  const tile = (title: string, aside: string, body: string, opts: { icon?: EmojiName; cls?: string } = {}) =>
    `<section class="tile${opts.cls ? ` ${opts.cls}` : ''}"><h2><span>${icon(opts.icon)}${title}</span>${aside}</h2>${body}</section>`;
  const none = (text: string) => `<p class="empty">${e(text)}</p>`;
  const unavailable = none('World state unavailable right now.');
  const more = (n: number) => (n > 0 ? row(`<span class="n">…and ${n} more</span>`) : '');
  const heading = (text: string) => `<div class="sec">${text}</div>`;
  const tierBadge = (t: ArbyTier) => `<span class="tier tier-${t.toLowerCase()}" title="${t} tier">${t}</span>`;
  const plat = (n: number) => (icon('platinum') ? `${n} ${icon('platinum')}` : `${n}p`);
  /** Escaped reward text whose amounts stay on one line with their unit ("10,000 cr", "3 Forma"). */
  const reward = (text: string) => e(text).replace(/(\d) (?=[A-Za-z])/g, '$1&nbsp;');

  const status = s.online ? `<span class="live"><span class="dot"></span>Online${s.pingMs !== null ? ` · ${s.pingMs} ms` : ''}</span>` : '<span class="live off"><span class="dot"></span>Offline</span>';
  const facts = [
    `${e(String(s.server?.memberCount ?? '—'))} members`,
    `up ${e(formatDuration(s.uptimeSeconds * 1000))}`,
    `world state ${e(worldStateLine(s.warframeApi))}`,
    s.archive ? `wiki archive ${s.archive.pages.toLocaleString('en-US')}${s.archive.syncing ? ' · syncing' : ''}` : '',
  ].filter(Boolean).join(' · ');

  const clan = tile(
    'Clan events',
    `<span class="x">${s.upcomingEvents.length} upcoming</span>`,
    s.upcomingEvents.length
      ? s.upcomingEvents
          .map((ev) => row(e(ev.title), countdown(ev.startsAt), `<time datetime="${ev.startsAt}" data-local>${e(utc(ev.startsAt))}</time> · ${ev.going} going${ev.maybe ? `, ${ev.maybe} maybe` : ''}`))
          .join('')
      : none('Nothing scheduled. Create one with /event create.'),
  );

  const cycles = tile(
    'Day and night cycles',
    '',
    s.cycles ? s.cycles.map((c) => row(`${icon(c.emoji) || c.icon} ${e(c.name)} <b>${e(c.state)}</b>`, countdown(c.endsAt), c.note ? e(c.note) : '')).join('') : unavailable,
    { icon: 'cycle' },
  );

  const fissureTotal = w ? w.fissures.reduce((n, f) => n + f.normal + f.steelPath + f.storm, 0) : 0;
  /** `label` is HTML: the callers escape what they put in. */
  const chip = (attr: string, value: string, label: string) => `<button type="button" class="chip" data-${attr}="${e(value)}">${label}</button>`;
  const fissures = tile(
    'Void fissures',
    w ? `<span class="x">${fissureTotal} active · <span data-fcount>${w.fissureList.length} shown</span></span>` : '',
    !w
      ? unavailable
      : w.fissureList.length
        ? `<div class="chips">${[chip('kind', 'all', 'All'), chip('kind', 'normal', 'Normal'), chip('kind', 'sp', `${icon('steelPath')}Steel Path`), chip('kind', 'storm', `${icon('storm')}Void Storm`)].join('')}</div>
<div class="chips">${[chip('tier', 'all', 'Every tier'), ...w.fissures.map((f) => chip('tier', f.tier, `${icon(own(RELIC_ICON, f.tier))}${e(f.tier)} <span class="u">${f.normal + f.steelPath + f.storm}</span>`))].join('')}</div>
<div class="scroll"><table class="fx"><tbody>${w.fissureList
            .map((f) => {
              const k = f.storm ? 'storm' : f.steelPath ? 'sp' : 'normal';
              const kind = f.storm ? ' · Void Storm' : f.steelPath ? ' · Steel Path' : '';
              return `<tr data-tier="${e(f.tier)}" data-kind="${k}"><td class="t">${icon(own(RELIC_ICON, f.tier))}${e(f.tier)}</td><td>${e(f.mission)}<span class="n">${e(f.node)}${f.enemy ? ` · ${e(f.enemy)}` : ''}${kind}</span></td><td class="v">${countdown(f.endsAt)}</td></tr>`;
            })
            .join('')}</tbody></table></div>`
        : none('No fissures right now.'),
    { icon: 'fissure', cls: 'span2' },
  );

  // The Arbitration comes from the schedule, so it is shown while the world state is not.
  const arb = s.arbitration;
  const place = (h: ArbitrationHour) => `<b>${e(h.node)}</b>${h.planet ? `, ${e(h.planet)}` : ''}`;
  const what = (h: ArbitrationHour) => e([h.mission, h.faction].filter(Boolean).join(' · '));
  const arbRow = (h: ArbitrationHour, when: string, note: string) =>
    `<div class="r arb">${tierBadge(h.tier)}<span class="k">${place(h)}<span class="n">${note}</span></span><span class="v">${when}</span></div>`;
  const arbitration = tile(
    'Arbitration',
    arb?.now ? `<span class="x">ends ${countdown(arb.now.endsAt)}</span>` : '',
    !arb
      ? none('The Arbitration schedule can not be read right now; it comes back on its own.')
      : [
          arb.now
            ? `<div class="hero">${tierBadge(arb.now.tier)}<div><div class="lead">${place(arb.now)}</div><span class="n">${what(arb.now)} · ${e(TIER_HINT[arb.now.tier])}</span></div></div>`
            : none('No Arbitration is known for this hour.'),
          arb.next.length ? heading('Next hours') + arb.next.map((h) => arbRow(h, `<time datetime="${h.startsAt}" data-local="t">${utcClock(h.startsAt)}</time>`, what(h))).join('') : '',
          arb.best.length
            ? heading('Best of the week') + arb.best.map((h) => arbRow(h, countdown(h.startsAt), `<time datetime="${h.startsAt}" data-local>${e(utc(h.startsAt))}</time> · ${what(h)}`)).join('')
            : '',
          arb.trusted ? '' : '<p class="n">The schedule and the game disagree right now, so only the current hour is shown until they agree again.</p>',
          '<p class="src">Tiers by the Arbitration Goons · schedule from browse.wf</p>',
        ].join(''),
    { icon: 'arbitration' },
  );

  const alertCount = w ? w.alerts.reduce((n, a) => n + a.count, 0) : 0;
  const alerts = w?.alerts.length
    ? tile(
        'Alerts',
        `<span class="x">${alertCount}</span>`,
        w.alerts
          .map((a) =>
            row(
              `${a.notable ? '<span class="star">★</span> ' : ''}<b>${e(a.name)}</b>${a.count > 1 ? ` <span class="u">×${a.count}</span>` : ''}`,
              countdown(a.endsAt),
              `${e(a.where.slice(0, 3).join('; '))}${a.count > 3 ? ` · …and ${a.count - 3} more` : ''} · ${reward(a.reward)}${a.count > 1 ? ' each' : ''}`,
            ),
          )
          .join(''),
        { icon: 'alert' },
      )
    : '';

  // The headline numbers above the tiles: what changes next, at a glance.
  const stat = (label: string, value: string, note: string, ico: EmojiName) => `<div class="stat"><span class="sl">${icon(ico)}${label}</span><b class="sv">${value}</b><span class="ss">${note}</span></div>`;
  const nextCycle = s.cycles
    ?.filter((c) => c.endsAt && Date.parse(c.endsAt) > Date.now())
    .reduce<CycleStatus | null>((soonest, c) => (!soonest || Date.parse(c.endsAt!) < Date.parse(soonest.endsAt!) ? c : soonest), null);
  const strip = [
    nextCycle ? stat('Next change', `${icon(nextCycle.emoji) || nextCycle.icon} ${e(nextCycle.name)}`, `${e(nextCycle.state)} ends ${countdown(nextCycle.endsAt)}`, 'cycle') : '',
    w?.baro ? stat("Baro Ki'Teer", w.baro.here ? 'Here now' : 'Arriving', `${e(w.baro.location)} · ${countdown(w.baro.at)}`, 'baro') : '',
    arb?.now ? stat('Arbitration', `${tierBadge(arb.now.tier)}${e(arb.now.node)}`, `${e(arb.now.mission)} · ends ${countdown(arb.now.endsAt)}`, 'arbitration') : '',
    w?.sortie ? stat('Sortie', e(w.sortie.boss), `resets ${countdown(w.sortie.endsAt)}`, 'sortie') : '',
  ].join('');

  const group = (title: string, hint: string, tiles: string, open = false) =>
    tiles.trim() ? `<details class="group" data-g="${e(title)}"${open ? ' open' : ''}><summary><h3>${title}</h3><span>${hint}</span></summary><div class="grid">${tiles}</div></details>` : '';

  const sortie = !w
    ? tile('Sortie', '', unavailable, { icon: 'sortie' })
    : w.sortie
      ? tile(
          'Sortie',
          countdown(w.sortie.endsAt),
          `<div class="lead">${e(w.sortie.boss)}${w.sortie.faction ? ` · ${e(w.sortie.faction)}` : ''}</div>${w.sortie.missions
            .map((m, i) => row(`${i + 1}. ${e(m.type)}`, e(m.node), e(m.modifier)))
            .join('')}`,
          { icon: 'sortie' },
        )
      : '';

  const archon = w?.archon
    ? tile('Archon Hunt', countdown(w.archon.endsAt), `<div class="lead">${e(w.archon.boss)}</div>${w.archon.missions.map((m, i) => row(`${i + 1}. ${e(m.type)}`, e(m.node))).join('')}`, { icon: 'archon' })
    : '';

  const ducats = icon('ducats') || '<span class="u">ducats</span>';
  const baro = w?.baro
    ? tile(
        "Baro Ki'Teer",
        countdown(w.baro.at),
        `<div class="lead">${w.baro.here ? `Here at ${e(w.baro.location)}` : `Arrives at ${e(w.baro.location)}`}</div>${w.baro.items
          .slice(0, 5)
          .map((i) => row(e(i.name), `${i.ducats} ${ducats}`))
          .join('')}${more(w.baro.items.length - 5)}`,
        { icon: 'baro' },
      )
    : '';

  const steel = w?.steelPath
    ? tile(
        'Steel Path honors',
        countdown(w.steelPath.endsAt),
        row(`<b>${e(w.steelPath.current)}</b>`, `${w.steelPath.cost} ${icon('steelPath') || 'essence'}`) + (w.steelPath.next ? row(`Next week: ${e(w.steelPath.next)}`) : ''),
        { icon: 'steelPath' },
      )
    : '';

  const darvo = w?.darvo
    ? tile(
        "Darvo's deal",
        countdown(w.darvo.endsAt),
        row(`<b>${e(w.darvo.item)}</b>`, `<b>${plat(w.darvo.price)}</b> <s>${w.darvo.original}</s>`, `-${w.darvo.discount}% · ${w.darvo.left > 0 ? `${w.darvo.left} of ${w.darvo.total} left` : 'sold out'}`),
        { icon: 'darvo' },
      )
    : '';

  const invasions = w?.invasions.length
    ? tile(
        'Invasions',
        `<span class="x">${w.invasions.length} active</span>`,
        w.invasions
          .slice(0, 4)
          .map((i) => row(`${i.notable ? '<span class="star">★</span> ' : ''}${e(i.node)}`, `${i.completion}%`, reward(i.rewards)))
          .join('') + more(w.invasions.length - 4),
        { icon: 'invasion' },
      )
    : '';

  const events = w?.events.length
    ? tile('Events', '', w.events.map((ev) => row(e(ev.name), countdown(ev.endsAt), [ev.progress !== null ? `${ev.progress}% done` : '', reward(ev.rewards)].filter(Boolean).join(' · '))).join(''), {
        icon: 'event',
      })
    : '';

  const nightwave = w?.nightwave
    ? tile(
        `Nightwave · S${w.nightwave.season}`,
        countdown(w.nightwave.endsAt),
        w.nightwave.challenges
          .slice(0, 5)
          .map((c) => row(`${e(c.title)}<span class="tag">${c.kind}</span>`, c.reputation.toLocaleString('en-US')))
          .join('') + more(w.nightwave.challenges.length - 5),
        { icon: 'nightwave' },
      )
    : '';

  const archimedea = w?.archimedea.length
    ? tile('Archimedea', '', w.archimedea.map((a) => row(`<b>${e(a.name)}</b>`, countdown(a.endsAt), e(a.missions.join(' · ')))).join(''))
    : '';

  const resurgence = w?.resurgence
    ? tile(
        'Prime Resurgence',
        countdown(w.resurgence.endsAt),
        `<p class="n">${e(w.resurgence.items.slice(0, 12).join(' · '))}${w.resurgence.items.length > 12 ? ` · …and ${w.resurgence.items.length - 12} more` : ''}</p>`,
        { icon: 'varzia' },
      )
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#010c18">
${s.archive?.syncing ? '<meta http-equiv="refresh" content="15">' : ''}
<title>${e(s.botName)} · ${e(s.clanName)}</title>
<link rel="icon" href="/logo.png">
<style nonce="${nonce}">${STATUS_CSS}</style>
</head>
<body>
<main>
<header>
<img class="logo" src="/logo.png" alt="" width="44" height="44">
<div><h1>${e(s.botName)}</h1><div class="sub">Companion of ${e(s.clanName)}${s.server && s.server.name !== s.clanName ? ` · ${e(s.server.name)}` : ''}</div></div>
${status}
</header>
${strip ? `<div class="strip">${strip}</div>` : ''}
<div class="groups">
${group('Open worlds', 'cycles and the Void Trader', cycles + baro, true)}
${group('The Void', 'fissures and the Arbitration schedule', fissures + arbitration, true)}
${group('Resets', 'daily, weekly and seasonal', sortie + archon + steel + archimedea + nightwave)}
${group('Events and trading', 'the clan, alerts, invasions and deals', clan + alerts + invasions + events + darvo + resurgence)}
</div>
<footer><p>${facts}</p>World state from warframestat.us · updated <time datetime="${s.generatedAt}" data-local>${e(utc(s.generatedAt))}</time> · refreshes automatically · <a href="/admin/">Admin</a></footer>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
