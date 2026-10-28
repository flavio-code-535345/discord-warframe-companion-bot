import { type Guild, type GuildMember, type Message } from 'discord.js';
import type { AppContext } from '../context.js';
import { MESSAGE_COOLDOWN_MS, VOICE_XP_PER_MINUTE, levelOf, mayEarnMessageXp, planLevelRoles, rollMessageXp, type LevelRole } from './xp.js';

/** Messages and voice time earn XP; crossing a level hands out the matching "Level N+" role and announces it. */

export const levelingOn = (ctx: Pick<AppContext, 'store' | 'config'>): boolean => ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).levelingOff !== 1;

const roleList = (guild: Guild): LevelRole[] => [...guild.roles.cache.values()].map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed }));

/** Gives the member the tier role for their level and takes the other tiers away. Returns the role added, if any. */
export async function syncLevelRoles(guild: Guild, member: GuildMember, level: number): Promise<LevelRole | null> {
  const me = guild.members.me;
  if (!me?.permissions.has('ManageRoles')) return null;
  const plan = planLevelRoles(roleList(guild), level, new Set(member.roles.cache.keys()), me.roles.highest.position);
  if (plan.add) await member.roles.add(plan.add.id, 'Level up').catch((err) => console.warn('[levels] could not add role:', (err as Error).message));
  if (plan.remove.length) await member.roles.remove(plan.remove.map((r) => r.id), 'Level up').catch((err) => console.warn('[levels] could not remove role:', (err as Error).message));
  return plan.add;
}

/** Level at which members may post images and embed links (the role permissions are set on the server). */
export const MEDIA_LEVEL = 10;

export function levelUpText(member: string, level: number, previous: number, roleName: string | null): string {
  const unlocked = previous < MEDIA_LEVEL && level >= MEDIA_LEVEL ? ' You can now post images and embed links!' : '';
  return `🎉 ${member} reached **level ${level}**!${roleName ? ` New role: **${roleName}**.` : ''}${unlocked}`;
}

async function announce(ctx: AppContext, member: GuildMember, level: number, previous: number, fallback: Message | null, role: LevelRole | null): Promise<void> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).levelChannelId;
  const channel = channelId ? await ctx.client.channels.fetch(channelId).catch(() => null) : fallback?.channel;
  if (!channel || !channel.isTextBased() || !('send' in channel)) return;
  const text = levelUpText(String(member), level, previous, role?.name ?? null);
  await channel.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => {});
}

/** Awards XP and handles a level-up. `message` is only used to announce where the member was talking. */
async function award(ctx: AppContext, member: GuildMember, amount: number, now: number, message: Message | null): Promise<void> {
  const { before, after } = ctx.store.addXp(member.guild.id, member.id, amount, now, message !== null);
  const level = levelOf(after);
  const previous = levelOf(before);
  if (level === previous) return;
  const role = await syncLevelRoles(member.guild, member, level);
  await announce(ctx, member, level, previous, message, role);
}

/** Called for every message in the server. */
export async function handleLevelMessage(message: Message, ctx: AppContext): Promise<void> {
  if (!message.inGuild() || message.guildId !== ctx.config.DISCORD_GUILD_ID) return;
  if (message.author.bot || message.webhookId || message.system || !message.member) return;
  if (!levelingOn(ctx)) return;
  const s = ctx.store.getSettings(message.guildId);
  if ([s.honeypotChannelId, s.ssRolesChannelId, s.verifyChannelId, s.rivenChannelId].includes(message.channelId)) return;
  if (ctx.store.getSticky(message.channelId)?.deleteOthers) return;
  if (ctx.store.xpIgnoredChannels(message.guildId).includes(message.channelId)) return;

  const now = Date.now();
  const last = ctx.store.getMemberXp(message.guildId, message.author.id)?.lastXpAt ?? 0;
  if (!mayEarnMessageXp(last, now)) return;
  await award(ctx, message.member, rollMessageXp(), now, message);
}

/** Once a minute, members who are in a voice channel with someone else (not deafened, not AFK) earn a little XP. */
export class LevelVoiceTicker {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((err) => console.warn('[levels] voice tick failed:', (err as Error).message)), MESSAGE_COOLDOWN_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const { ctx } = this;
    if (!levelingOn(ctx)) return;
    const guild = ctx.client.guilds.cache.get(ctx.config.DISCORD_GUILD_ID);
    if (!guild) return;
    const ignored = new Set(ctx.store.xpIgnoredChannels(guild.id));
    const now = Date.now();
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased() || channel.id === guild.afkChannelId || ignored.has(channel.id)) continue;
      const humans = [...channel.members.values()].filter((m) => !m.user.bot);
      if (humans.length < 2) continue;
      for (const m of humans) {
        if (m.voice.deaf || m.voice.mute) continue;
        // One member's failure must not take the minute's XP away from everyone after them.
        await award(ctx, m, VOICE_XP_PER_MINUTE, now, null).catch((err) => console.warn('[levels] voice XP failed:', (err as Error).message));
      }
    }
  }
}
