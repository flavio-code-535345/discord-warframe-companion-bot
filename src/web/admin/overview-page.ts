import { ChannelType, type Guild } from 'discord.js';
import type { Request, Response, Router } from 'express';
import type { AppContext } from '../../context.js';
import type { GuildSettings } from '../../db.js';
import { FEEDS, feedHealth } from '../../discord/feeds/index.js';
import { jobs } from '../../jobs.js';
import { honeypotAction } from '../../moderation/honeypot.js';
import type { JobStats } from '../../scheduler.js';
import { formatDuration } from '../../time.js';
import { buildStatus, escapeHtml as e, worldStateLine } from '../status.js';
import { type PageContext, badge, head, layout, statCard } from './pages.js';

/**
 * The panel's Overview: is Ordis healthy (the background jobs, the World State boards, the world state source) and where does each
 * feature post. `CHANNEL_SETTINGS` is also the Settings page's channel form, so both list the same settings in the same order.
 */

/** The settings that hold one optional Discord id (not `guildId`, which is always set). */
type IdSetting = { [K in keyof GuildSettings]: null extends GuildSettings[K] ? (GuildSettings[K] extends string | null ? K : never) : never }[keyof GuildSettings];

export interface ChannelSetting {
  key: IdSetting;
  label: string;
  kind: 'channel' | 'role';
  /** What leaving it empty means (the select's first option). */
  empty?: string;
}

export const CHANNEL_SETTINGS: { title: string; fields: ChannelSetting[] }[] = [
  {
    title: 'Core',
    fields: [
      { key: 'announcementsChannelId', label: 'Announcements and events', kind: 'channel' },
      { key: 'welcomeChannelId', label: 'Welcome', kind: 'channel' },
      { key: 'chatChannelId', label: 'Ordis chat', kind: 'channel' },
    ],
  },
  {
    title: 'Logs',
    fields: [
      { key: 'modLogChannelId', label: 'Moderation log', kind: 'channel' },
      { key: 'auditLogChannelId', label: 'Audit log', kind: 'channel', empty: '— same as the moderation log —' },
      { key: 'statusChannelId', label: 'Start and stop reports', kind: 'channel' },
    ],
  },
  {
    title: 'Community',
    fields: [
      { key: 'birthdayChannelId', label: 'Birthdays', kind: 'channel' },
      { key: 'weeklyChannelId', label: 'Weekly reset post', kind: 'channel' },
      { key: 'promoChannelId', label: 'Promo codes', kind: 'channel' },
      { key: 'newsChannelId', label: 'Game news', kind: 'channel' },
      { key: 'levelChannelId', label: 'Level-ups', kind: 'channel', empty: '— where the member is talking —' },
    ],
  },
  {
    title: 'Squads',
    fields: [{ key: 'lfgChannelId', label: 'Squads started from a board', kind: 'channel', empty: '— not set —' }],
  },
];

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  guild: () => Promise<Guild>;
}

/** Discord's limits for one Components V2 message; a board within 15% of one is flagged. */
const TEXT_LIMIT = 4000;
const COMPONENT_LIMIT = 40;

/** `formatDuration` with seconds below a minute, where it would round (a 45 s job, a run a moment ago). */
const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.floor(ms / 1000))}s` : formatDuration(ms));
const ago = (at: number, now: number) => (now - at < 5_000 ? 'just now' : `${span(now - at)} ago`);
const until = (at: number, now: number) => (at <= now ? 'due' : `in ${span(at - now)}`);
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A table row, with a full-width line under it for what needs saying (an error, earlier failures, a board near Discord's limit). */
function row(cells: string[], detail?: string): string {
  const tds = cells.map((c) => `<td>${c}</td>`).join('');
  return detail ? `<tr class="lead">${tds}</tr><tr class="detail"><td colspan="${cells.length}">${detail}</td></tr>` : `<tr>${tds}</tr>`;
}

/** The last round that finished threw; a running round is judged when it ends. */
const lastRunFailed = (j: JobStats): boolean => j.lastFailed && !j.running;

export function registerOverviewRoutes({ router, ctx, pc, html, guild }: Deps): void {
  const { config, store } = ctx;

  router.get('/', async (req, res) => {
    const now = Date.now();
    const s = await buildStatus(ctx);
    const settings = store.getSettings(config.DISCORD_GUILD_ID);
    const g = await guild().catch(() => null);
    const latest = store.listBackups(config.DISCORD_GUILD_ID)[0];
    const where = (id: string | null, kind: 'channel' | 'role' = 'channel', empty?: string): string => {
      if (!id) return empty ? `<span class="muted">${e(empty.replace(/^— | —$/g, ''))}</span>` : badge('off');
      if (kind === 'role') return `<code>@${e(g?.roles.cache.get(id)?.name ?? id)}</code>`;
      const ch = g?.channels.cache.get(id) as { name?: string; type?: ChannelType } | undefined;
      const hash = ch?.type === ChannelType.GuildCategory || ch?.type === ChannelType.GuildVoice ? '' : '#';
      return `<code>${hash}${e(ch?.name ?? id)}</code>`;
    };

    const jobList = jobs.stats().sort((a, b) => a.name.localeCompare(b.name));
    const failing = jobList.filter(lastRunFailed);
    const started = jobList.some((j) => j.runs > 0 || j.running);
    const api = s.warframeApi;
    const next = s.upcomingEvents[0];
    const nextLeft = next ? Date.parse(next.startsAt) - now : 0;

    const cards = [
      statCard('Bot', s.online ? 'Online' : 'Offline', `${s.pingMs !== null ? `${s.pingMs} ms · ` : ''}up ${e(formatDuration(s.uptimeSeconds * 1000))}`, { tone: s.online ? 'ok' : 'bad' }),
      statCard('Background jobs', !started ? 'Starting' : failing.length ? `${failing.length} failing` : 'All OK', failing.length ? e(failing.map((j) => j.name).join(', ')) : `${jobList.length} jobs`, {
        tone: !started ? undefined : failing.length ? 'bad' : 'ok',
      }),
      statCard('World state', !api.enabled ? 'Off' : !api.lastCallAt ? 'Waiting' : api.lastOk ? 'OK' : 'Failing', e(worldStateLine(api)), {
        tone: !api.enabled || !api.lastCallAt ? undefined : api.lastOk ? 'ok' : 'bad',
      }),
      statCard('Members', e(String(s.server?.memberCount ?? '—')), `${s.registeredMembers} registered in-game names`),
      statCard('Upcoming events', String(s.upcomingEvents.length), next ? `${e(next.title)}, ${nextLeft > 0 ? `in ${e(formatDuration(nextLeft))}` : 'happening now'}` : 'nothing planned'),
      statCard('Latest backup', latest ? `#${latest.id}` : '—', latest ? ago(latest.createdAt, now) : 'none yet'),
    ];

    const jobRows = jobList
      .map((j) => {
        const failed = lastRunFailed(j);
        const state = j.running ? badge('running', 'info') : failed ? badge('failed', 'bad') : j.runs ? badge('ok', 'ok') : badge('waiting');
        const detail = failed
          ? `<span class="bad">${e(j.lastError ?? '')}</span>`
          : j.failures && j.lastErrorAt !== null
            ? `${j.failures} of ${j.runs} rounds failed, the last ${ago(j.lastErrorAt, now)}: ${e(j.lastError ?? '')}`
            : undefined;
        return row(
          [
            `<b>${e(j.name)}</b>`,
            span(j.everyMs),
            j.lastStartAt ? `${ago(j.lastStartAt, now)}${j.lastMs !== null ? ` · ${took(j.lastMs)}` : ''}` : '—',
            j.nextAt && !j.running ? until(j.nextAt, now) : '—',
            String(j.runs),
            state,
          ],
          detail,
        );
      })
      .join('');

    const health = feedHealth();
    const boardRows = FEEDS.map((f) => {
      const h = health[f.id]!;
      const channel = settings[f.channel];
      const near = h.maxText > TEXT_LIMIT * 0.85 || h.maxComponents > COMPONENT_LIMIT * 0.85;
      const [state, detail] = !channel
        ? [badge('off')]
        : h.error
          ? [badge('error', 'bad'), `<span class="bad">${e(h.error)}</span>`]
          : h.action === 'skipped'
            ? [badge('kept', 'warn'), 'The world state could not be read, so the board still shows the last round.']
            : near
              ? [badge('near the limit', 'warn'), `Its fullest message has ${h.maxText} of ${TEXT_LIMIT} characters and ${h.maxComponents} of ${COMPONENT_LIMIT} components.`]
              : [h.at ? badge('ok', 'ok') : badge('waiting')];
      return row(
        [
          `<b>${e(f.label)}</b>`,
          where(channel),
          h.at && channel ? `${ago(h.at, now)}${h.action ? ` · ${e(h.action)}` : ''}` : '—',
          state,
        ],
        detail,
      );
    }).join('');

    const groups = [
      ...CHANNEL_SETTINGS.map((grp) => ({ title: grp.title, rows: grp.fields.map((f) => [f.label, where(settings[f.key], f.kind, f.empty)] as const) })),
      {
        title: 'Tools',
        rows: [
          ['Screenshot roles', where(settings.ssRolesChannelId)],
          ['Riven scanning', where(settings.rivenChannelId)],
          ['Honeypot', settings.honeypotChannelId ? `${where(settings.honeypotChannelId)} ${badge(honeypotAction(settings.honeypotAction), 'warn')}` : badge('off')],
          ['Squad voice', settings.lfgVoiceCategoryId ? where(settings.lfgVoiceCategoryId) : badge('off')],
          ['Join-to-create voice', where(settings.autoVcHubChannelId)],
          ['Leveling', settings.levelingOff === 1 ? badge('off') : badge('on', 'ok')],
        ] as const,
      },
    ];

    const body = `${head('Overview', 'How Ordis and the clan server are doing right now.')}
<div class="grid stats3">${cards.join('')}</div>
<h2>Background jobs</h2>
<div class="card">${jobRows ? `<table class="compact ops jobs"><tr><th>Job</th><th>Every</th><th>Last run</th><th>Next</th><th>Runs</th><th>State</th></tr>${jobRows}</table>` : '<p class="muted">The jobs start once Ordis is connected to Discord.</p>'}</div>
<h2>World State boards</h2>
<div class="card"><table class="compact ops boards"><tr><th>Board</th><th>Channel</th><th>Last round</th><th>State</th></tr>${boardRows}</table></div>
<h2>Channels</h2>
<div class="cols2">${groups
      .map((grp) => `<div class="card"><h3>${e(grp.title)}</h3><table class="compact kv">${grp.rows.map(([label, value]) => `<tr><td>${e(label)}</td><td>${value}</td></tr>`).join('')}</table></div>`)
      .join('')}</div>
<p><a href="/admin/settings">Change channels and boards in Settings →</a></p>`;
    html(res, layout('Overview', body, pc(res, 'overview', req)));
  });
}
