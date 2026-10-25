# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

"Cephalon Ordis", the Discord bot for the Warframe clan "The Rats Den 69" (TypeScript, ESM, Node 24, discord.js v14). It also serves an MCP server over HTTP and is published as a Docker image (`flavio11113/rats-den-warframe-bot`) to Docker Hub by GitHub Actions.

**Identity:** `src/discord/identity.ts` syncs the bot's Discord username (`BOT_NAME`) and avatar (`assets/clan-logo.png`, which the Dockerfile copies into the image) on every `ClientReady`. It only calls the API when something differs, because Discord rate-limits both; the avatar hash is kept in the `bot_meta` table. Embeds use `brandIcon(ctx)` (the bot's avatar URL) for icons, and `COLORS.brand` is the crystal blue sampled from the logo.

## Commands

```bash
npm run dev          # tsx watch, loads .env (copy .env.example first)
npm run typecheck    # tsc --noEmit over src + test
npm test             # node:test via tsx, all test/**/*.test.ts
npx tsx --test test/db.test.ts                         # one file
npx tsx --test --test-name-pattern="markSeen" test/db.test.ts   # one test
npm run build        # tsc -p tsconfig.build.json → dist/
npm start            # node dist/index.js
```

TypeScript is v7 (native `tsc`). Relative imports must use `.js` extensions (NodeNext resolution).

## Architecture

`src/index.ts` builds one `AppContext` (`config`, `store`, discord `client`, see `src/context.ts`) and hands it to three consumers that run in the same process:

1. **Discord interactions** (`src/discord/bot.ts`): routes slash commands (`src/discord/commands/*`, each exporting a `Command`), autocomplete, and buttons (`src/discord/buttons.ts`). Commands are registered **guild-scoped** to `DISCORD_GUILD_ID` on every `ClientReady`; the bot deliberately serves only that one guild. Button custom IDs are `rsvp:<eventId>:<going|maybe|declined>` and `lfg:<postId>:<join|leave|close>`, so they keep working after restarts.
2. **Notifier** (`src/discord/notifier.ts`): polls the worldstate every `WORLDSTATE_POLL_SECONDS`. `collectAlerts()` is a pure function that returns every currently alert-worthy item with a stable `key`; `Store.markSeen(key)` de-duplicates across restarts. On an empty `seen_worldstate` table it records the current items without posting (no flood on first deploy). It also sends event reminders 15 minutes before start.
3. **HTTP server** (`src/http.ts`): the public status page `/` plus `/status.json` and `/logo.png` (`src/web/status.ts`). These are server-rendered with no build step; the page's inline style and script are allowed by a per-request CSP nonce, and every dynamic string goes through `escapeHtml`. `buildStatus` reads only cached Discord data and exposes aggregates, never member names or IDs. There's also `/health` (no auth, used by the Docker HEALTHCHECK) and, only when `MCP_AUTH_TOKEN` is set, `POST /mcp`. Express 5 reports listen errors through the `app.listen` callback, and the bot exits on them. MCP is **stateless Streamable HTTP**: a new `McpServer` (`src/mcp/server.ts`) and transport are built per request, so `createMcpServer` must not do I/O. Bearer auth runs before body parsing; `MCP_ALLOWED_HOSTS` adds DNS-rebinding Host checks.

**Free chat answers** (`src/answers/`): the default when there's no `ANTHROPIC_API_KEY`, and what the deployed bot uses (the owner won't pay for an AI API). `detectIntent()` in `intent.ts` is pure regex/keyword rules mapping a message to a lookup (price, drops, relic, world view, fissures, bounties, clan events, build, item, wiki fallback). Rule order matters: price before relic, and drops before world views. `test/intent.test.ts` pins real phrasings, so add a case when changing a rule. `smart.ts` turns an intent into an Ordis line plus an existing embed, and falls back to `searchWiki`, which prefers a page whose title appears in the question. `found: false` lets the chat channel stay silent.

**Claude chat (optional)** (`src/ai/`): `OrdisBrain.ask()` runs Claude through the SDK's beta tool runner (`client.beta.messages.toolRunner` with `betaZodTool` tools that reuse the same Warframe functions as the slash commands and MCP), plus the `web_search_20260209` server tool restricted to Warframe domains. The runner doesn't resume `pause_turn` by itself, so `ask()` pushes the paused turn back. The system prompt and tool order are a stable, cached prefix; per-request context (time, asker, channel) goes in the user turn. `fallbacks: "default"` + beta `server-side-fallback-2026-07-01` is sent only for model families that support it (not Haiku). Conversation history comes from the Discord reply chain (`src/discord/chat.ts`); each answer chunk replies to the previous one so that replying to any chunk continues the thread. `AskLimiter` is in-memory. Without `ANTHROPIC_API_KEY`, `ctx.ai` is null and chat is off. `test/ai.test.ts` drives the real SDK against a fake `fetch`, so it checks the request shape without spending money.

**Trackers** (`src/trackers.ts`): `collectTrackables(ws)` turns the worldstate into keyed items (invasions, alerts, Darvo, events, Steel Path, Varzia, Baro, fissures, cycle phases) and `matchTracker(spec, item)` is pure. The notifier de-duplicates per tracker with `seen_worldstate` keys `track:<id>:<item key>` and sends one DM per member per poll.

**Lookups** (`src/warframe/items.ts`, `wiki.ts`): warframestat.us `/items/search` for stats (a relic's four refinements are merged into one result, and rarity is derived from the intact chance because the export's labels are unreliable). Drop chances in both warframestat.us APIs are already percentages. The wiki uses MediaWiki `list=search` plus TextExtracts.

**Shared service layer:** `src/services/clan.ts` holds every operation that posts to Discord (events, announcements, LFG rendering, channel resolution). Slash commands and MCP tools both call it, so behaviour stays the same. Throw `UserError` for expected failures: Discord shows it ephemerally, and MCP returns it as an `isError` tool result. Any other error is logged and shown generically. `getSendableChannel` refuses channels outside the clan guild.

**Persistence:** `src/db.ts` uses the built-in `node:sqlite` (`DatabaseSync`, synchronous), so there are no native npm deps. That's also why the Dockerfile can build on `$BUILDPLATFORM` and copy `node_modules` into the arm64 image. The schema is versioned through `PRAGMA user_version` and the append-only `MIGRATIONS` array: never edit a shipped migration, add a new entry. Times are stored as epoch ms. Tests use `new Store(':memory:')`.

**Warframe data** (`src/warframe/`):
- Worldstate comes from DE's official `api.warframe.com/cdn/worldState.php`, parsed locally with `warframe-worldstate-parser` and cached ~55s. The warframestat.us `/pc` worldstate endpoint was returning 404, so don't switch back to it. The parser needs `import 'reflect-metadata'` to load first. Its models type most dates as `Date | undefined`, so go through `toMs`/`discordTime`/`relative` in `src/time.ts`, which tolerate missing values.
- warframe.market must use **API v2** (v1 returns 403 "Deprecated"). Its Cloudflare blocks Node's default User-Agent, so every outbound call goes through `apiFetch` in `src/warframe/fetch.ts`.
- Drop tables come from warframestat.us (`/drops/search/`), which still works.

Discord-facing formatting lives in `src/discord/embeds.ts`. MCP returns plain JSON built by `src/mcp/worldstate-summary.ts`, with no Discord markup and ISO times plus an "in 2h 5m" string.

## Deployment

`.github/workflows/docker-publish.yml` runs typecheck and tests, then buildx builds `linux/amd64,linux/arm64`. It pushes to Docker Hub (except on PRs) using the secrets `DOCKER_USERNAME`/`DOCKER_PASSWORD`. The image is `vars.DOCKERHUB_IMAGE`, or `<username>/rats-den-warframe-bot` when that variable is unset. Tags: `latest` on main, semver on `v*.*.*` tags, and `sha-<short>`. Runtime data goes in `/app/data` (a volume). `.mcp.json` points Claude Code at the running bot via `RATS_DEN_MCP_URL`/`RATS_DEN_MCP_TOKEN`.

`docker-compose.yml` is the production stack: `bot` plus `caddy` (`caddy reverse-proxy` CLI, automatic HTTPS for `BOT_DOMAIN`, so there's no Caddyfile) plus `watchtower`. Watchtower uses the maintained `nickfedor/watchtower` fork, since `containrrr/watchtower` is archived. It updates only containers labelled `com.centurylinklabs.watchtower.enable=true`, which means only `bot`. The bot's settings are passed one by one through `environment:` interpolation instead of `env_file`, so the same file works with a local `.env` and as a Portainer stack. A new bot env var therefore has to be added in `src/config.ts`, `.env.example` and the `bot.environment` block of the compose file. The live deployment runs as a Portainer stack with values inline (no Caddy: a Cloudflare Tunnel points at the bot's port), so new settings also need adding there.
