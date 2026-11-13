# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

"Cephalon Ordis", the Discord bot for the Warframe clan "The Rats Den 69" (TypeScript, ESM, Node 24, discord.js v14). It also serves an MCP server over HTTP and is published as a Docker image (`flavio11113/rats-den-warframe-bot`) to Docker Hub by GitHub Actions.

This file holds what applies everywhere: the commands, the rules and how the parts fit together. The details of each feature are in a `CLAUDE.md` beside its code (listed at the end), which Claude Code loads on its own when a file in that folder is opened.

## Commands

```bash
npm run dev          # tsx watch, loads .env (copy .env.example first)
npm run typecheck    # tsc --noEmit over src + test
npm test             # node:test via tsx, all test/**/*.test.ts
npx tsx --test test/db.test.ts                         # one file
npx tsx --test --test-name-pattern="markSeen" test/db.test.ts   # one test
npm run build        # tsc -p tsconfig.build.json → dist/
npm start            # node dist/index.js
npx tsc --noEmit --noUnusedLocals   # unused imports and locals: the plain typecheck does not flag them, and there is no linter
```

TypeScript is v7 (native `tsc`). Relative imports must use `.js` extensions (NodeNext resolution).

Tests need no network and no Discord: `new Store(':memory:')` for the database (`new Store(path, { migrateTo })` stops at an older schema version, to test a migration), a fake clock and a fake `fetch` for the scheduler and the API client, and stub clients and guilds for Discord (`test/backup.test.ts` has a fake Guild, `test/admin.test.ts` drives the panel over HTTP).

## Rules

- **Never call a Digital Extremes host** (`api.warframe.com` or any other). The world state comes from warframestat.us only: calling DE's API yourself breaches their EULA, a blocked IP can't log in to the game either, and the clan's co-owner asked for it to be removed fully.
- **No model in the chat answers and no paid AI API.** Answers are exact lookups and wiki quotes (`src/answers/`). The only model is the screenshot roles' vision fallback (self-hosted, then a free tier). Ask before adding a model anywhere.
- **Removed at the owner's request, do not bring back without asking:** the model answers and everything around them (the list is in `src/answers/CLAUDE.md`), the `/ai` command with its panel page and switches, captcha verification, live code patches, the dojo research board, the starboard, and role pings.
- **Ordis pings no role.** Every notification is a DM a member asked for (a tracker). The client is created with `DEFAULT_MENTIONS` (`parse: ['users']`); the one role ping left is the role staff names by hand in an announcement.
- **Every outbound Warframe call goes through the one `ApiClient`** (`apiFetch` / `apiJson` in `src/warframe/fetch.ts`): the pacing, cooldowns, cache and User-Agent live there.
- **A recurring task is a job** in `registerJobs` (`src/jobs.ts`), never a `setInterval`.
- **Migrations are append-only:** never edit a shipped entry of `MIGRATIONS` (`src/db.ts`), add a new one. A new guild setting is a migration plus one line in `SETTINGS_COLUMNS`.
- **A new environment variable** goes in `src/config.ts`, `.env.example` and the `bot.environment` block of `docker-compose.yml`, and the live Portainer stack has its values inline, so it has to be added there by hand too. One that should be changeable in the panel also gets an entry in `SETTINGS` (`src/runtime-config.ts`).
- **A channel that reads every message gets one job** (chat, honeypot, screenshot roles, riven scanning, each board): call `assertChannelFree` before saving such a setting.
- **Expected failures throw `UserError`** (`src/errors.ts`, re-exported by `services/clan.ts`): Discord shows it ephemerally, MCP returns it as an `isError` result. Anything else is logged and shown generically.
- **The data modules never import from the layers above them:** `src/warframe/`, `src/wiki/`, `src/imaging/`, `trackers.ts` and the small helpers load nothing from `discord/`, `services/`, `web/` or `mcp/` (what they need from above is handed in, or the shared piece moves down, as `UserError` did). An import circle through them once made the load order decide whether the bot starts; `test/layers.test.ts` checks this and loads the entry point's imports in their real order.
- **Outside data is never trusted to have its shape** (member text, wiki pages, the world state feed; the paragraph is below): `own()` for a table looked up with someone else's key, `escapeHtml` for every dynamic string on a page, `withTimeout` instead of a bare `Promise.race`.
- **A custom ID carries what its handler needs**, so buttons and menus keep working after a restart. Bump a board's `version` in `FEEDS` when its layout changes.
- **The notes follow the code:** a change to a feature updates the `CLAUDE.md` of its folder (or this file, for what applies everywhere), and the README when members or staff would notice it.

## Architecture

`src/index.ts` builds one `AppContext` (`config`, `store`, discord `client`, see `src/context.ts`) and hands it to three consumers that run in the same process:

1. **Discord** (`src/discord/bot.ts`): slash commands (`src/discord/commands/*`, each exporting a `Command`), autocomplete, buttons, menus and modals. Commands are registered **guild-scoped** to `DISCORD_GUILD_ID` on every `ClientReady`: the bot deliberately serves only that one guild. Each message goes through the handlers in a fixed order (honeypot, screenshot roles, riven channel, then chat; the first one that takes it ends the chain), while the sticky keeper, the activity tracker and leveling see every message.
2. **Notifier** (`src/discord/notifier.ts`): every minute the `world-state` job reads the world state and the Arbitration schedule, redraws the seven World State boards (`src/discord/feeds/`), DMs what matches the members' trackers and makes the weekly post.
3. **HTTP server** (`src/http.ts`): the public status page `/` with `/status.json` and `/logo.png` (`src/web/status.ts`), `/health` (no auth, used by the Docker HEALTHCHECK), the admin panel at `/admin` (`src/web/admin/`) and, only when `MCP_AUTH_TOKEN` is set, `POST /mcp`. MCP is **stateless Streamable HTTP**: a new `McpServer` (`src/mcp/server.ts`) and transport are built per request, so `createMcpServer` must not do I/O; bearer auth runs before body parsing, and `MCP_ALLOWED_HOSTS` adds DNS-rebinding Host checks. Every answer carries `securityHeaders`, and `errorHandler` is the last middleware: a failure is logged and answered with one line, never a stack. Express 5 reports listen errors through the `app.listen` callback, and the bot exits on them.

**Background jobs** (`src/scheduler.ts`, `src/jobs.ts`): every recurring task is one named job of the `jobs` scheduler, registered in `registerJobs` and started at ClientReady (`jobs.stop()` in `shutdown`): `events` (reminders, ended events), `giveaways`, `birthdays`, `promo-codes`, `news`, `price-alerts` (30 min), `riven-watch` (5 min), `world-state`, `baro-prices` (20 s while Baro is here, else asleep until he lands), `squad-voice`, `voice-xp`, `backups` (hourly check), `emojis` (30 min), `riven-crawl` and `wiki-index`. A job never runs twice at once, a throw is logged and counted but stops nothing else, and a job may return the delay until its next run. `get_bot_health.jobs` and the admin Overview show each job's runs, failures, whether the last round failed (`lastFailed`), the last error and the next run. Do not add a `setInterval` for a new recurring task: add a job. `test/scheduler.test.ts` uses a fake clock.

**Shared service layer:** `src/services/clan.ts` holds every operation that posts to Discord (events, announcements, LFG rendering, channel resolution). `assertChannelFree(ctx, patch)` is the one rule for channels that read every message (chat, honeypot, screenshot roles, riven scanning): a channel gets one job, and every place that assigns one (the `/setup` commands, the panel's settings form, MCP `update_bot_settings`) calls it before saving anything. `createClanEvent` refuses a start in the past or more than two years away. Slash commands and MCP tools both call it, so behaviour stays the same. Throw `UserError` for expected failures: Discord shows it ephemerally, and MCP returns it as an `isError` tool result. Any other error is logged and shown generically. `getSendableChannel` refuses channels outside the clan guild.

**Persistence:** `src/db.ts` uses the built-in `node:sqlite` (`DatabaseSync`, synchronous), so there are no native npm deps. That's also why the Dockerfile can build on `$BUILDPLATFORM` and copy `node_modules` into the arm64 image. The schema is versioned through `PRAGMA user_version` and the append-only `MIGRATIONS` array: never edit a shipped migration, add a new entry. Times are stored as epoch ms. Tests use `new Store(':memory:')`. Guild settings live in the `SETTINGS_COLUMNS` table in `db.ts`, so a new setting means a migration plus one line there.

**Settings** (`src/config.ts`, `src/runtime-config.ts`): the environment is validated once with zod. The settings in `SETTINGS` can also be changed on the panel's Config page without a redeploy: a panel value is stored in `bot_meta` as `cfg_<NAME>`, applied on top of the environment at every start and written into the shared `config` object, so every `ctx.config.X` read sees it at once (panel value, then environment, then built-in default). Secrets and tokens, `DISCORD_GUILD_ID`, `DATA_DIR`, `HTTP_HOST`/`PORT`, `PUBLIC_URL`, `PANEL_OWNER_IDS`, `MCP_ALLOWED_HOSTS` and `WATCHTOWER_URL` are environment-only (`ENV_ONLY`). More in `src/web/CLAUDE.md`.

**Queue** (`src/queue.ts`; Config page group "Queues": `QUEUE_SCREENSHOTS_CONCURRENCY` (default 1, so a CPU reads one picture at a time), `QUEUE_MAX_WAITING` (20); one person may have 2 running or waiting): `WorkQueue` is an in-memory FIFO with `join(key, onPosition)` returning a ticket (`position()`, `ready`, `release()`; a stuck job is released after 6 min; `QueueFullError` when the person or the line is full). `screenshotQueue` is used by the screenshot roles and riven scans: `handleSsMessage` joins it first, REPLIES to the member's message with the queue message (or the usual "Reading your screenshot") and downloads the picture, then waits for its turn before reading; the 90 s limit only counts the reading. `get_bot_health.queues` and the Config page show the queue state. `test/queue.test.ts`.

**Status reports** (`src/lifecycle.ts`, `/setup status`): `reportStart` (on `clientReady`) and `reportStop` (first thing in `shutdown`, bounded by a 4 s timeout so it can't hold up Docker's stop; a restart from the panel or the MCP goes through the same `shutdown` because `index.ts` registers it with `onRestart` in `src/selfupdate.ts`, and `scheduleRestart` gives it 8 s before it exits anyway) post to the staff `statusChannelId`. `bot_meta` keeps `lifecycle_state` (`running`/`stopped`), so a start after `running` is reported as an unclean stop (crash/kill) and after `stopped` as a normal restart with the downtime.

**Outside data is never trusted to have its shape** (the code and security audit of 2026-11-10, `test/security-audit.test.ts`): a member's text, a wiki page and the world state feed are all someone else's input. A plain table looked up with such a key goes through `own()` (the calculator's functions and constants, the wiki's HTML entities, relic tiers, polarities, Archimedea names, the status page's icons: `constructor(2)+1` used to be 3 and `&constructor;` used to become the text of a built-in function), and the emoji registry answers an unknown name with "no emoji" instead of throwing. On the status page `escapeHtml` takes anything, and `worldOf` turns what the page writes as a number into one (`num`), so a feed that sends markup where a number belongs can't write it onto the public page. The Discord client is created with `DEFAULT_MENTIONS` (`parse: ['users']`): a message that sets no `allowedMentions` can never ping a role or everyone, and every place that means to ping a role names it itself. Addresses in the configuration (`httpUrl` in config.ts) must be http or https. The API client holds bounded amounts: `readText` gives up on an answer over `MAX_BODY_BYTES` (32 MB), the in-memory cache has a size budget as well as a count (`MEMORY_CHARS`, one answer over a quarter of it is not held), and `Store.trimApiCache` keeps the stored cache under 200 MB, oldest first (every different search is its own entry for 30 days). The panel takes an ID from an address only when it is a Discord ID (`idParam`).

**Small guards** (each has a test): `src/imaging/size.ts` reads the size a PNG/JPEG/WebP header declares and refuses anything over 40 million pixels before a decoder allocates it (a 43 KB file can declare 6000x6000; `normalizeImage`, `decodeImage`, `decodeWebp` and `scanCard` all check); `src/timeout.ts` `withTimeout` races work against a limit and clears its timer (use it instead of a bare `Promise.race` with a `setTimeout`); `src/own.ts` `own(table, key)` looks a user-typed or model-chosen key up in a plain table without finding `constructor`/`toString`; `apiJson` only caches an answer that looks like JSON, so a Cloudflare HTML page sent with HTTP 200 is an error (stale data is served instead) and is never stored; the OCR stat-line pattern in `rivens/card.ts` is a flat character class on purpose (a nested group made it exponential on a long symbol run).

Discord-facing formatting lives in `src/discord/embeds.ts`. MCP returns plain JSON built by `src/mcp/worldstate-summary.ts`, with no Discord markup and ISO times plus an "in 2h 5m" string.

## Deployment

`.github/workflows/docker-publish.yml` runs typecheck and tests, then buildx builds `linux/amd64,linux/arm64`. It pushes to Docker Hub (except on PRs) using the secrets `DOCKER_USERNAME`/`DOCKER_PASSWORD`. The image is `vars.DOCKERHUB_IMAGE`, or `<username>/rats-den-warframe-bot` when that variable is unset. Tags: `latest` on main, semver on `v*.*.*` tags, and `sha-<short>`. Runtime data goes in `/app/data` (a volume). `.mcp.json` points Claude Code at the running bot via `RATS_DEN_MCP_URL`/`RATS_DEN_MCP_TOKEN`.

`docker-compose.yml` is the production stack: `bot` plus `caddy` (`caddy reverse-proxy` CLI, automatic HTTPS for `BOT_DOMAIN`, so there's no Caddyfile) plus `watchtower`. Watchtower uses the maintained `nickfedor/watchtower` fork, since `containrrr/watchtower` is archived. It updates only containers labelled `com.centurylinklabs.watchtower.enable=true`, which means only `bot`. The `bot` service drops every capability and sets `no-new-privileges` (it runs as the unprivileged `node` user and needs neither). The bot's settings are passed one by one through `environment:` interpolation instead of `env_file`, so the same file works with a local `.env` and as a Portainer stack. A new bot env var therefore has to be added in `src/config.ts`, `.env.example` and the `bot.environment` block of the compose file. The live deployment runs as a Portainer stack with values inline (no Caddy: a Cloudflare Tunnel points at the bot's port), so new settings also need adding there.

## Notes beside the code

Each folder below has a `CLAUDE.md` with the details of what lives there. It loads on its own when a file in that folder is opened; read it yourself first when you plan a change there without having opened one.

| Folder | What its notes cover |
|---|---|
| `src/discord/` | interaction routing and custom IDs, the notifier, live boards (`board.ts`), trackers and DMs, notifications as DM subscriptions, emojis, embed style, identity, editing Ordis's messages, events with end times, price alerts, the weekly post, promo codes, game news |
| `src/discord/feeds/` | the seven World State boards |
| `src/warframe/` | the world state (warframestat.us, polling), the API client, item and drop lookups, Arbitrations, relic values, Baro prices, web search |
| `src/wiki/` | the local wiki index: crawler, cleaning, FTS5 search |
| `src/answers/` | chat answers (the order in `smartAnswer`, intents, wiki quotes), what was removed with the model answers, the question log |
| `src/rivens/` | the riven analyzer: market crawl, grading, OCR scan, the picture, find and watch |
| `src/ssroles/` | screenshot roles (OCR, emblem, vision fallback) and the local Ollama model |
| `src/imaging/` | WebP decoding, the image size guard, drawing with pureimage |
| `src/web/` | the status page, the admin panel, the web theme, the Config page (runtime config) |
| `src/mcp/` | the MCP server, the insight tools, the server admin tools |
| `src/alecaframe/` | AlecaFrame links, the stats chart, the relic planner |
| `src/lfg/` | squads, squad voice, activities, join-to-create rooms |
| `src/selfroles/`, `src/activity/`, `src/giveaways/`, `src/birthdays/` | the roles panel, the inactivity report, giveaways, birthdays |
| `src/moderation/`, `src/backup/`, `src/leveling/`, `src/sticky/`, `src/logging/` | purge, lock and honeypot; server backups and restore; XP and level roles; sticky messages; the audit log |

The files directly in `src/` are covered in this file, except `trackers.ts` (in `src/discord/CLAUDE.md`) and `runtime-config.ts` (in `src/web/CLAUDE.md`).
