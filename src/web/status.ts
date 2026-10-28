import type { AppContext } from '../context.js';
import { getWikiIndex } from '../wiki/index.js';
import { projectCycles } from '../warframe/cycles.js';
import { formatDuration, relative, toMs } from '../time.js';
import { STATUS_CSS } from './theme.js';
import {
  FISSURE_TIERS,
  NOTABLE_REWARD,
  type WorldState,
  archimedeaName,
  getWorldState,
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
  generatedAt: string;
}

const ICONS: Record<string, string> = {
  day: '☀️', night: '🌙', warm: '🔥', cold: '❄️', fass: '🟠', vome: '🔵', corpus: '🔷', grineer: '🔶',
  joy: '😊', anger: '😠', envy: '💚', sorrow: '😢', fear: '😨',
};

const iso = (d: Date | string | number | undefined | null) => (Number.isNaN(toMs(d)) ? null : new Date(toMs(d)).toISOString());

function cyclesOf(ws: WorldState, now = Date.now()): CycleStatus[] {
  const p = projectCycles(ws, now);
  const cycle = (name: string, key: string, expiry: Date | string | number | undefined, extra: { suffix?: string; note?: string } = {}): CycleStatus => ({
    name,
    state: key.charAt(0).toUpperCase() + key.slice(1) + (extra.suffix ?? ''),
    icon: ICONS[key.toLowerCase()] ?? '◆',
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
    cycle('Duviri', ws.duviriCycle.state, ws.duviriCycle.expiry, { note: circuit.length ? `Circuit: ${circuit.join(', ')}` : undefined }),
  ];
}

/** Each part is read defensively: one malformed section must not blank the whole page. */
function worldOf(ws: WorldState, now = Date.now()): WorldTiles {
  const live = (d: Date | string | undefined) => toMs(d) > now;
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
        items: here ? [...(t.inventory ?? [])].sort((x, y) => (y.ducats ?? 0) - (x.ducats ?? 0)).map((i) => ({ name: i.item, ducats: i.ducats ?? 0 })) : [],
      };
    }, null),
    steelPath: part(() => {
      const sp = ws.steelPath;
      if (!sp?.currentReward) return null;
      const rot = sp.rotation ?? [];
      const idx = rot.findIndex((r) => r.name === sp.currentReward!.name);
      return { current: sp.currentReward.name, cost: sp.currentReward.cost, next: idx >= 0 ? (rot[(idx + 1) % rot.length]?.name ?? null) : null, endsAt: iso(sp.expiry) };
    }, null),
    darvo: part(() => {
      const d = ws.dailyDeals?.find((x) => live(x.expiry));
      return d ? { item: d.item, price: d.salePrice, original: d.originalPrice, discount: d.discount, left: d.total - d.sold, total: d.total, endsAt: iso(d.expiry) } : null;
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
            return { node: i.node, rewards, completion: Math.round(i.completion), notable: NOTABLE_REWARD.test(rewards) };
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
            progress: ev.maximumScore > 1 ? Math.round((ev.currentScore / ev.maximumScore) * 100) : null,
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
        season: nw.season,
        endsAt: iso(nw.expiry),
        challenges: [...nw.activeChallenges]
          .sort((a, b) => Number(b.isDaily) - Number(a.isDaily) || Number(a.isElite) - Number(b.isElite))
          .map((c) => ({ title: c.title, kind: c.isDaily ? 'daily' : c.isElite ? 'elite' : 'weekly', reputation: c.reputation })),
      };
    }, null),
    resurgence: part(() => {
      const v = ws.vaultTrader;
      return v?.inventory?.length && live(v.expiry) ? { endsAt: iso(v.expiry), items: v.inventory.map((i) => resurgenceItemName(i.item)) } : null;
    }, null),
  };
}

/** Collects everything the public status page shows. Uses only cached Discord data, so page views cost no API calls. */
function apiPill(a: StatusData['warframeApi']): string {
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

export async function buildStatus(ctx: AppContext, loadWorldState: () => Promise<WorldState> = getWorldState): Promise<StatusData> {
  const { client, config, store } = ctx;
  const online = client.isReady();
  const guild = online ? client.guilds.cache.get(config.DISCORD_GUILD_ID) : undefined;
  const ping = online ? client.ws.ping : -1;

  let cycles: CycleStatus[] | null = null;
  let world: WorldTiles | null = null;
  try {
    const ws = await loadWorldState();
    cycles = cyclesOf(ws);
    world = worldOf(ws);
  } catch {
    // The notifier already logs worldstate failures; the page just shows those tiles as unavailable.
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
      .map((e) => {
        const r = store.getRsvps(e.id);
        return { id: e.id, title: e.title, startsAt: new Date(e.startsAt).toISOString(), going: r.going.length, maybe: r.maybe.length };
      }),
    cycles,
    world,
    generatedAt: new Date().toISOString(),
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Server-side fallback text; the page script replaces it with the reader's local time. */
const utc = (isoTime: string) => `${new Date(isoTime).toUTCString().slice(0, 22)} UTC`;

const countdown = (isoTime: string | null) =>
  isoTime ? `<span class="cd" data-until="${isoTime}">${escapeHtml(relative(isoTime))}</span>` : '<span class="cd">—</span>';

const SCRIPT = `
const fmt=ms=>{const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return d?d+'d '+h+'h':h?h+'h '+m+'m':m?m+'m '+s+'s':s+'s'};
const local=new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
document.querySelectorAll('time[data-local]').forEach(t=>{t.textContent=local.format(new Date(t.dateTime))});
const loaded=Date.now();let reloadAt=loaded+300000;
function tick(){const now=Date.now();document.querySelectorAll('[data-until]').forEach(el=>{const left=Date.parse(el.dataset.until)-now;el.textContent=left>0?'in '+fmt(left):'now';if(left<=0)reloadAt=Math.min(reloadAt,Math.max(loaded+30000,now+5000))});if(now>=reloadAt)location.reload()}
tick();setInterval(tick,1000);
`;

export function renderStatusPage(s: StatusData, nonce: string): string {
  const e = escapeHtml;
  const w = s.world;
  const row = (k: string, v = '', note = '') => `<div class="r"><span class="k">${k}${note ? `<span class="n">${note}</span>` : ''}</span><span class="v">${v}</span></div>`;
  const tile = (title: string, aside: string, body: string) => `<section class="tile"><h2><span>${title}</span>${aside}</h2>${body}</section>`;
  const none = (text: string) => `<p class="empty">${e(text)}</p>`;
  const unavailable = none('World state unavailable right now.');
  const more = (n: number) => (n > 0 ? row(`<span class="n">…and ${n} more</span>`) : '');

  const pills = [
    s.online ? `<span class="pill"><span class="dot"></span><b>Online</b>${s.pingMs !== null ? ` ${s.pingMs} ms` : ''}</span>` : '<span class="pill off"><span class="dot"></span><b>Offline</b></span>',
    `<span class="pill">up <b>${e(formatDuration(s.uptimeSeconds * 1000))}</b></span>`,
    `<span class="pill"><b>${e(String(s.server?.memberCount ?? '—'))}</b> members</span>`,
    `<span class="pill"><b>${s.registeredMembers}</b> registered</span>`,
    `<span class="pill">World state <b>${e(apiPill(s.warframeApi))}</b></span>`,
    s.archive ? `<span class="pill">archive <b>${s.archive.pages.toLocaleString('en-US')}${s.archive.syncing && s.archive.total ? ` / ${s.archive.total.toLocaleString('en-US')}` : ''}</b>${s.archive.syncing ? ' · syncing' : ''}</span>` : '',
  ].join('');

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
    'Open worlds',
    '',
    s.cycles ? s.cycles.map((c) => row(`${c.icon} ${e(c.name)} <b>${e(c.state)}</b>`, countdown(c.endsAt), c.note ? e(c.note) : '')).join('') : unavailable,
  );

  const fissures = tile(
    'Void fissures',
    w ? `<span class="x">${w.fissures.reduce((n, f) => n + f.normal + f.steelPath + f.storm, 0)} active</span>` : '',
    !w
      ? unavailable
      : w.fissures.length
        ? `<table><tr><th>Tier</th><th>Normal</th><th>Steel Path</th><th>Storm</th></tr>${w.fissures
            .map((f) => `<tr><td>${e(f.tier)}</td>${[f.normal, f.steelPath, f.storm].map((n) => `<td class="${n ? '' : 'z'}">${n}</td>`).join('')}</tr>`)
            .join('')}</table>`
        : none('No fissures right now.'),
  );

  const sortie = !w
    ? tile('Sortie', '', unavailable)
    : w.sortie
      ? tile(
          'Sortie',
          countdown(w.sortie.endsAt),
          `<div class="lead">${e(w.sortie.boss)}${w.sortie.faction ? ` · ${e(w.sortie.faction)}` : ''}</div>${w.sortie.missions
            .map((m, i) => row(`${i + 1}. ${e(m.type)}`, e(m.node), e(m.modifier)))
            .join('')}`,
        )
      : '';

  const archon = w?.archon
    ? tile('Archon Hunt', countdown(w.archon.endsAt), `<div class="lead">${e(w.archon.boss)}</div>${w.archon.missions.map((m, i) => row(`${i + 1}. ${e(m.type)}`, e(m.node))).join('')}`)
    : '';

  const baro = w?.baro
    ? tile(
        "Baro Ki'Teer",
        countdown(w.baro.at),
        `<div class="lead">${w.baro.here ? `Here at ${e(w.baro.location)}` : `Arrives at ${e(w.baro.location)}`}</div>${w.baro.items
          .slice(0, 8)
          .map((i) => row(e(i.name), `${i.ducats} <span class="u">ducats</span>`))
          .join('')}${more(w.baro.items.length - 8)}`,
      )
    : '';

  const steel = w?.steelPath
    ? tile('Steel Path honors', countdown(w.steelPath.endsAt), row(`<b>${e(w.steelPath.current)}</b>`, `${w.steelPath.cost} essence`) + (w.steelPath.next ? row(`Next week: ${e(w.steelPath.next)}`) : ''))
    : '';

  const darvo = w?.darvo
    ? tile(
        "Darvo's deal",
        countdown(w.darvo.endsAt),
        row(`<b>${e(w.darvo.item)}</b>`, `<b>${w.darvo.price}p</b> <s>${w.darvo.original}p</s>`, `-${w.darvo.discount}% · ${w.darvo.left > 0 ? `${w.darvo.left} of ${w.darvo.total} left` : 'sold out'}`),
      )
    : '';

  const invasions = w?.invasions.length
    ? tile(
        'Invasions',
        `<span class="x">${w.invasions.length} active</span>`,
        w.invasions
          .slice(0, 6)
          .map((i) => row(`${i.notable ? '<span class="star">★</span> ' : ''}${e(i.node)}`, `${i.completion}%`, e(i.rewards)))
          .join('') + more(w.invasions.length - 6),
      )
    : '';

  const events = w?.events.length
    ? tile('Events', '', w.events.map((ev) => row(e(ev.name), countdown(ev.endsAt), [ev.progress !== null ? `${ev.progress}% done` : '', e(ev.rewards)].filter(Boolean).join(' · '))).join(''))
    : '';

  const nightwave = w?.nightwave
    ? tile(
        `Nightwave · S${w.nightwave.season}`,
        countdown(w.nightwave.endsAt),
        w.nightwave.challenges
          .slice(0, 8)
          .map((c) => row(`${e(c.title)}<span class="tag">${c.kind}</span>`, c.reputation.toLocaleString('en-US')))
          .join('') + more(w.nightwave.challenges.length - 8),
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
<div class="pills">${pills}</div>
</header>
<div class="tiles">
${clan}${cycles}${fissures}${sortie}${archon}${baro}${steel}${darvo}${invasions}${events}${nightwave}${archimedea}${resurgence}
</div>
<footer>World state from warframestat.us · updated <time datetime="${s.generatedAt}" data-local>${e(utc(s.generatedAt))}</time> · refreshes automatically · <a href="/admin/">Admin</a></footer>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
