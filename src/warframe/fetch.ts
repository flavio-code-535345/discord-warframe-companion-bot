// warframe.market sits behind Cloudflare, which answers Node's default User-Agent with a 403 challenge page.
const USER_AGENT = 'cephalon-ordis/1.0 (Discord bot for the Warframe clan The Rats Den 69)';

/** fetch with an identifying User-Agent and a timeout, for every third-party Warframe API. */
export function apiFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(20_000) });
}
