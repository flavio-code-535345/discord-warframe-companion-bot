import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Store } from '../../db.js';

export const SESSION_COOKIE = 'ordis_session';
export const STATE_COOKIE = 'ordis_oauth';
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
const DISCORD_API = 'https://discord.com/api/v10';

/** Per-installation HMAC key for cookies, created once and kept in the database. */
export function sessionSecret(store: Store): Buffer {
  let hex = store.getMeta('panel_session_secret');
  if (!hex) {
    hex = randomBytes(32).toString('hex');
    store.setMeta('panel_session_secret', hex);
  }
  return Buffer.from(hex, 'hex');
}

const mac = (value: string, secret: Buffer) => createHmac('sha256', secret).update(value).digest('base64url');

export const sign = (value: string, secret: Buffer) => `${value}.${mac(value, secret)}`;

export function unsign(signed: string | undefined, secret: Buffer): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(value, secret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed escape would otherwise turn the request into a 500; the cookie is just taken as is.
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, eq).trim()] = raw;
    }
  }
  return out;
}

/** Cookies are scoped to /admin, HTTP-only, HTTPS-only and same-site. */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/admin; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCookie = (name: string) => cookie(name, '', 0);

export const randomToken = () => randomBytes(24).toString('base64url');

export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Owners from PANEL_OWNER_IDS are always admins; everyone else must be on the whitelist. */
export function isPanelAdmin(config: Config, store: Store, userId: string): boolean {
  return config.PANEL_OWNER_IDS.includes(userId) || store.isPanelAdmin(userId);
}

export const redirectUri = (config: Config) => `${config.PUBLIC_URL}/admin/callback`;

export function authorizeUrl(clientId: string, config: Config, state: string): string {
  const qs = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: 'identify', redirect_uri: redirectUri(config), state });
  return `https://discord.com/oauth2/authorize?${qs}`;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

/** Trades the OAuth code for the user's identity. The access token is used once and never stored. */
export async function exchangeCode(clientId: string, config: Config, code: string): Promise<DiscordUser> {
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: config.DISCORD_CLIENT_SECRET!,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(config),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw new Error(`Discord rejected the login (HTTP ${tokenRes.status}).`);
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!userRes.ok) throw new Error(`Could not read your Discord profile (HTTP ${userRes.status}).`);
  return (await userRes.json()) as DiscordUser;
}

export const avatarUrl = (userId: string, avatar: string | null) =>
  avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png';
