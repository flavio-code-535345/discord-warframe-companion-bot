import type { AppContext } from '../context.js';
import { formatDuration, relative, toMs } from '../time.js';
import { type WorldState, getWorldState } from '../warframe/worldstate.js';

export interface CycleStatus {
  name: string;
  state: string;
  icon: string;
  endsAt: string | null;
  note?: string;
}

export interface StatusData {
  botName: string;
  clanName: string;
  online: boolean;
  pingMs: number | null;
  uptimeSeconds: number;
  server: { name: string; memberCount: number } | null;
  registeredMembers: number;
  upcomingEvents: { id: number; title: string; startsAt: string; going: number; maybe: number }[];
  /** null when the worldstate could not be loaded. */
  cycles: CycleStatus[] | null;
  generatedAt: string;
}

const ICONS: Record<string, string> = {
  day: '☀️', night: '🌙', warm: '🔥', cold: '❄️', fass: '🟠', vome: '🔵', corpus: '🔷', grineer: '🔶',
  joy: '😊', anger: '😠', envy: '💚', sorrow: '😢', fear: '😨',
};

function cyclesOf(ws: WorldState): CycleStatus[] {
  const iso = (d: Date | string | undefined) => (Number.isNaN(toMs(d)) ? null : new Date(toMs(d)).toISOString());
  const cycle = (name: string, key: string, expiry: Date | string | undefined, extra: { suffix?: string; note?: string } = {}): CycleStatus => ({
    name,
    state: key.charAt(0).toUpperCase() + key.slice(1) + (extra.suffix ?? ''),
    icon: ICONS[key.toLowerCase()] ?? '◆',
    endsAt: iso(expiry),
    note: extra.note,
  });
  const circuit = ws.duviriCycle.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  return [
    cycle('Cetus', ws.cetusCycle.isDay ? 'day' : 'night', ws.cetusCycle.expiry),
    cycle('Orb Vallis', ws.vallisCycle.isWarm ? 'warm' : 'cold', ws.vallisCycle.expiry),
    cycle('Cambion Drift', ws.cambionCycle.state, ws.cambionCycle.expiry),
    cycle('Zariman', ws.zarimanCycle.state, ws.zarimanCycle.expiry, { suffix: ' control' }),
    cycle('Earth', ws.earthCycle.isDay ? 'day' : 'night', ws.earthCycle.expiry),
    cycle('Duviri', ws.duviriCycle.state, ws.duviriCycle.expiry, { note: circuit.length ? `Circuit: ${circuit.join(', ')}` : undefined }),
  ];
}

/** Collects everything the public status page shows. Uses only cached Discord data, so page views cost no API calls. */
export async function buildStatus(ctx: AppContext, loadWorldState: () => Promise<WorldState> = getWorldState): Promise<StatusData> {
  const { client, config, store } = ctx;
  const online = client.isReady();
  const guild = online ? client.guilds.cache.get(config.DISCORD_GUILD_ID) : undefined;
  const ping = online ? client.ws.ping : -1;

  let cycles: CycleStatus[] | null = null;
  try {
    cycles = cyclesOf(await loadWorldState());
  } catch {
    // The notifier already logs worldstate failures; the page just shows the section as unavailable.
  }

  return {
    botName: config.BOT_NAME,
    clanName: config.CLAN_NAME,
    online,
    pingMs: ping >= 0 ? ping : null,
    uptimeSeconds: Math.floor(process.uptime()),
    server: guild ? { name: guild.name, memberCount: guild.memberCount } : null,
    registeredMembers: store.listMembers(config.DISCORD_GUILD_ID).length,
    // Titles and counts only: who RSVP'd stays inside Discord.
    upcomingEvents: store
      .upcomingEvents(config.DISCORD_GUILD_ID)
      .slice(0, 8)
      .map((e) => {
        const r = store.getRsvps(e.id);
        return { id: e.id, title: e.title, startsAt: new Date(e.startsAt).toISOString(), going: r.going.length, maybe: r.maybe.length };
      }),
    cycles,
    generatedAt: new Date().toISOString(),
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Server-side fallback text; the page script replaces it with the reader's local time. */
const utc = (iso: string) => `${new Date(iso).toUTCString().slice(0, 22)} UTC`;

const countdown = (iso: string | null) =>
  iso ? `<span class="countdown" data-until="${iso}">${escapeHtml(relative(iso))}</span>` : '<span class="countdown">unknown</span>';

const STYLE = `
:root{--bg:#010c18;--bg2:#0b2846;--card:rgba(255,255,255,.045);--border:rgba(59,154,199,.28);--accent:#3b9ac7;--glow:rgba(59,154,199,.45);--text:#e6eef6;--muted:#8fa7bd;--ok:#22c55e;--bad:#ef4444}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top,var(--bg2),var(--bg) 70%) fixed;color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}
header{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.logo{width:96px;height:96px;border-radius:22px;box-shadow:0 0 40px var(--glow)}
h1{margin:0;font-size:28px;letter-spacing:.02em}
.sub{color:var(--muted);margin-top:2px}
.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:13px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
.offline .dot{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.pill.status{color:var(--text)}
section{margin-top:32px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 0 12px;font-weight:600}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.grid.stats,.grid.cycles{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:560px){.grid.cycles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:480px){.grid.stats .stat{font-size:22px}.grid.stats .card{padding:12px}}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 16px;min-width:0}
.stat{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.label{color:var(--muted);font-size:13px}
.state{font-size:18px;font-weight:600;margin:2px 0}
.note{color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere}
.countdown{font-variant-numeric:tabular-nums;color:var(--accent)}
.events{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.event{display:flex;justify-content:space-between;align-items:baseline;gap:4px 16px;flex-wrap:wrap}
.event-title{font-weight:600;overflow-wrap:anywhere}
.empty{color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
`;

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
  const statusPill = s.online
    ? `<span class="pill status"><span class="dot"></span>Online${s.pingMs !== null ? ` · ${s.pingMs} ms` : ''}</span>`
    : '<span class="pill status offline"><span class="dot"></span>Offline</span>';

  const stats = [
    { label: 'Discord members', value: s.server?.memberCount ?? '—' },
    { label: 'Registered Tenno', value: s.registeredMembers },
    { label: 'Upcoming events', value: s.upcomingEvents.length },
  ]
    .map((x) => `<div class="card"><div class="stat">${e(String(x.value))}</div><div class="label">${e(x.label)}</div></div>`)
    .join('');

  const cycles = s.cycles
    ? `<div class="grid cycles">${s.cycles
        .map(
          (c) =>
            `<div class="card"><div class="label">${e(c.name)}</div><div class="state">${c.icon} ${e(c.state)}</div>` +
            `<div class="label">ends ${countdown(c.endsAt)}</div>${c.note ? `<div class="note">${e(c.note)}</div>` : ''}</div>`,
        )
        .join('')}</div>`
    : '<p class="empty">The Warframe worldstate is unavailable right now.</p>';

  const events = s.upcomingEvents.length
    ? `<ul class="events">${s.upcomingEvents
        .map(
          (ev) =>
            `<li class="card event"><span class="event-title">${e(ev.title)}</span>` +
            `<span class="label"><time datetime="${ev.startsAt}" data-local>${e(utc(ev.startsAt))}</time> · ${countdown(ev.startsAt)} · ${ev.going} going${ev.maybe ? `, ${ev.maybe} maybe` : ''}</span></li>`,
        )
        .join('')}</ul>`
    : '<p class="empty">Nothing scheduled. Create one in Discord with <code>/event create</code>.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#010c18">
<title>${e(s.botName)} · ${e(s.clanName)}</title>
<link rel="icon" href="/logo.png">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<header>
<img class="logo" src="/logo.png" alt="" width="96" height="96">
<div>
<h1>${e(s.botName)}</h1>
<div class="sub">Companion of ${e(s.clanName)}${s.server && s.server.name !== s.clanName ? ` · ${e(s.server.name)}` : ''}</div>
<div class="meta">${statusPill}<span class="pill">Up ${e(formatDuration(s.uptimeSeconds * 1000))}</span></div>
</div>
</header>
<section aria-label="Clan stats"><h2>Clan</h2><div class="grid stats">${stats}</div></section>
<section aria-label="Open world cycles"><h2>Current cycles</h2>${cycles}</section>
<section aria-label="Upcoming events"><h2>Upcoming events</h2>${events}</section>
<footer>World state from Digital Extremes · updated <time datetime="${s.generatedAt}" data-local>${e(utc(s.generatedAt))}</time> · refreshes automatically</footer>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
