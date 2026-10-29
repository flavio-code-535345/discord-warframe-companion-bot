import { ChannelType } from 'discord.js';
import type { Request, Response, Router } from 'express';
import type { AppContext } from '../../context.js';
import type { PanelSession } from '../../db.js';
import { MAX_MESSAGE_CHARS, editOwnMessage, ownMessages } from '../../discord/messages.js';
import { UserError } from '../../services/clan.js';
import { escapeHtml as e } from '../status.js';
import { type Option, type PageContext, csrfField, head, layout, select } from './pages.js';

/**
 * The panel's Messages page: pick a channel, see the messages Ordis wrote there (rules, guides, notices) and change their text.
 * Discord only lets a bot edit its own messages, so nobody else's appear here. Server-rendered forms, no script.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
  channelOptions: () => Promise<Option[]>;
}

const id = (v: unknown) => (typeof v === 'string' && /^\d{15,22}$/.test(v) ? v : null);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function registerMessagesRoutes({ router, ctx, pc, html, audit, channelOptions }: Deps): void {
  const { client, config } = ctx;
  const guildId = config.DISCORD_GUILD_ID;

  /** A text channel of the clan server, or a UserError. */
  async function textChannel(channelId: string | null) {
    if (!channelId) throw new UserError('Pick a channel first.');
    const guild = await client.guilds.fetch(guildId);
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) throw new UserError('That is not a text channel of the clan server.');
    return channel;
  }

  router.get('/messages', async (req, res) => {
    const p = pc(res, 'messages', req);
    const channels = await channelOptions();
    const wanted = id(req.query.channel);
    let list = '';
    if (wanted) {
      try {
        const channel = await textChannel(wanted);
        const botId = client.user?.id ?? '';
        const own = await ownMessages(channel, botId, 100);
        list = own.length
          ? own
              .map(
                (m) => `<div class="card stack">
<div class="muted">${e(when(m.createdTimestamp))} UTC · <a href="${e(m.url)}" target="_blank" rel="noreferrer">open in Discord</a>${m.pinned ? ' · 📌 pinned' : ''}${m.embeds.length ? ` · ${m.embeds.length} embed${m.embeds.length > 1 ? 's' : ''} (kept as they are)` : ''}</div>
${m.embeds.length && !m.content ? `<p class="flush muted">This message is only an embed${m.embeds[0]?.title ? ` ("${e(clip(m.embeds[0].title, 60))}")` : ''}. Saving text here adds text above it.</p>` : ''}
<form class="stack" method="post" action="/admin/messages/edit">${csrfField(p.session)}<input type="hidden" name="channel" value="${e(wanted)}"><input type="hidden" name="message" value="${e(m.id)}">
<label>Text<textarea name="content" rows="${Math.min(14, Math.max(3, m.content.split('\n').length + 1))}" maxlength="${MAX_MESSAGE_CHARS}" required>${e(m.content)}</textarea></label>
<div><button>Save message</button></div></form>
</div>`,
              )
              .join('')
          : '<p class="muted">Ordis has not written any of the latest 100 messages in this channel.</p>';
      } catch (err) {
        list = `<div class="flash err">${e(err instanceof UserError ? err.message : 'Could not read that channel.')}</div>`;
      }
    }
    const body = `${head('Messages', 'Change the text of messages Ordis posted: rules, role guides, notices. Discord only lets him edit his own messages.')}
<div class="card"><form class="stack" method="get" action="/admin/messages"><div class="row"><label>Channel${select('channel', channels, wanted, '— pick a channel —')}</label></div><div><button class="ghost">Show Ordis's messages</button></div></form></div>
${list}`;
    html(res, layout('Messages', body, p));
  });

  // Saving returns to the same channel's list, so several messages can be edited in a row.
  router.post('/messages/edit', async (req, res) => {
    const channelId = id(req.body.channel);
    const back = (msg: { ok?: string; err?: string }) =>
      res.redirect(`/admin/messages?${new URLSearchParams({ ...(channelId ? { channel: channelId } : {}), ...(msg.ok ? { ok: msg.ok } : { err: msg.err ?? '' }) })}`);
    try {
      const messageId = id(req.body.message);
      if (!messageId) throw new UserError('Pick a message.');
      const channel = await textChannel(channelId);
      const content = typeof req.body.content === 'string' ? req.body.content : '';
      const edited = await editOwnMessage(channel, messageId, content, client.user?.id ?? '');
      await audit(res.locals.session as PanelSession, 'Edited a bot message', [
        { name: 'Channel', value: `#${channel.name}` },
        { name: 'New text', value: clip(edited.content, 300) },
      ]);
      back({ ok: 'Saved. The message in Discord now has the new text.' });
    } catch (err) {
      if (!(err instanceof UserError)) console.error('[admin] /messages/edit failed:', err);
      back({ err: err instanceof UserError ? err.message : 'Something went wrong; check the bot logs.' });
    }
  });
}
