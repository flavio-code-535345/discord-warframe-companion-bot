<p align="center"><img src="assets/clan-logo.png" width="128" alt="Cephalon Ordis logo"></p>

# Cephalon Ordis — The Rats Den 69 clan bot

**Cephalon Ordis** is the Discord companion bot for the Warframe clan **The Rats Den 69**. It answers Warframe
questions in chat (free, from live game data and the wiki), looks up items and relics, shows the live world state and
market prices, DMs members about things they track, runs clan events and LFG squads, posts automatic alerts, and
serves an **MCP server** so AI assistants (Claude Code, Claude Desktop, …) can read Warframe data and manage the clan.

## Features

### Ask Ordis

Mention the bot (`@Cephalon Ordis where does Neo N16 drop?`), use `/ask`, or DM it (clan members only). Ordis
works out what you're asking and answers from live data. No AI model or API key is involved, so it costs nothing:

| You ask | Ordis answers with |
| --- | --- |
| "price of Arcane Energize", "how much is Wisp Prime set worth?" | warframe.market sellers and buyers |
| "where does Neo N16 drop?", "how do I get Condition Overload?", "what drops Nitain?" | the relic card or the drop tables |
| "Kuva Bramma stats", "what's in Axi A1?", "build for Wisp Prime" | the item or relic card (builds add Overframe and wiki links) |
| "when is Baro coming?", "is it night on Cetus?", "today's sortie", "Entrati bounties", "steel path axi fissures", "what is Varzia selling?" | the live world state |
| "when is our next clan event?" | the clan's upcoming events |
| anything else ("how do Archon Shards work?") | the best-matching wiki article |
| "help" | examples of what to ask |

Optionally, `/setup chat` names a channel where Ordis answers every message ending in `?` (needs the Message Content
intent; see *Optional: Claude-powered chat* below).

### Commands

| Command | What it does |
| --- | --- |
| `/ask question` | Ask Ordis anything about Warframe |
| `/item name` | Stats for a Warframe (abilities, polarities), weapon (damage, crit, status, riven disposition), mod or arcane (max-rank effect, best drop sources) or relic (contents with intact → radiant chances, vaulted status) |
| `/wf cycles · fissures · sortie · archon · baro · steelpath · invasions · nightwave · deals · events · archimedea · bounties · resurgence` | Live world state, including Darvo's deal, events, Deep/Temporal Archimedea, syndicate bounties and Varzia's Prime Resurgence |
| `/price item` | warframe.market cheapest online sellers and top buyers, with a ready-to-paste whisper |
| `/drops item` | Where an item, mod or relic drops, with chances |
| `/wiki query` | Wiki article summary and link |
| `/track reward · fissure · cycle · baro · list · remove` | Personal DM alerts: a reward containing a word (invasions, alerts, events, Darvo, Baro, Varzia, Steel Path), fissures matching tier/mission/Steel Path, a cycle starting (e.g. Cetus night), Baro arriving |
| `/clan info · register · unregister · whois · roster` | Link Discord members to in-game names, MR and platform |
| `/event create · list · cancel` | Clan events with ✅ / 🤔 / ❌ RSVP buttons and a reminder ping 15 min before start |
| `/lfg activity [details] [size]` | Squad post with Join / Leave / Close buttons; pings everyone when full |
| `/setup alerts · announcements · welcome · chat · modlog · off · show` | (Manage Server) choose channels and the alert ping role |

### Moderation

| Command | Who can use it | What it does |
| --- | --- | --- |
| `/purge amount [user] [bots_only] [include_pinned]` | Manage Messages | Deletes the last 1–1000 messages, or `all`, in the current channel. Pinned messages are kept unless asked. More than 100, or `all`, asks for confirmation first. Messages older than 14 days can't be bulk-deleted by Discord, so they're removed one by one (up to 300 per run) |
| `/warn user reason` · `/warnings user [clear]` | Timeout Members | Recorded warnings, DMed to the member |
| `/timeout user duration [reason]` · `/untimeout user` | Timeout Members | Discord timeout, e.g. `10m`, `1h`, `1d` (max 28 days) |
| `/kick user [reason]` | Kick Members | Removes the member (DMed first) |
| `/ban user [reason] [delete_messages]` · `/unban user` | Ban Members | Bans by user (even if they've left); unban picks from the ban list |
| `/slowmode interval [channel]` | Manage Channels | `off` or e.g. `10s`, `2m` (max 6h) |
| `/lock [channel] [reason]` · `/unlock [channel]` | Manage Channels | Members can't post; roles with Manage Messages still can. Unlock restores the exact previous permissions |

Commands are hidden from members without the permission. Nobody can act on themselves, the owner, Ordis, or anyone
whose top role is at or above theirs or Ordis's. Every action is posted to the `/setup modlog` channel and recorded
in Discord's audit log with the moderator's name.

### Server backups (Xenon-style)

Ordis snapshots the server: roles (permissions, colors, order), categories and channels (permissions, topics,
slowmode, voice settings), emojis, bans, server settings and its own channel setup. Message history is included too
when `ENABLE_MESSAGE_CONTENT=true`, with the last 50 messages per channel.

| Command (Administrator) | What it does |
| --- | --- |
| `/backup create [label]` | Take a backup now |
| `/backup list` · `/backup info id` | Stored backups and what's in them |
| `/backup download id` | Get the backup as a `.json` file to keep somewhere safe |
| `/backup import file` | Load a downloaded file back into Ordis, even on a brand-new server |
| `/backup load id [mode] [bans] [messages]` | Restore. Shows a preview of every change and waits for confirmation |
| `/backup delete id` | Remove a stored backup |

- **Automatic:** a backup is taken every day, and the newest 14 are kept. Manual backups stay until you delete them.
- **Restore modes:**
  - **Missing only** (the default) recreates what was deleted and touches nothing that still exists, so it's safe to run on a damaged server.
  - **Full sync** also resets existing roles, channels and server settings to how they were in the backup.
- **Safety:** a restore never deletes anything, and it takes a fresh backup first so it can be undone.
- **Recovery:** recreated channels get their old position, category and permissions. Saved messages are re-posted into recreated channels through a webhook under the original author names. Ordis's own alert, event and mod-log channels are re-pointed automatically.
- **If the whole server is deleted:** create a new server, invite Ordis, set `DISCORD_GUILD_ID` to the new server and redeploy. Then run `/backup import` with a downloaded file (or use a stored backup) and `/backup load`. Bot roles from other bots come back when you re-invite those bots.
- **Where backups live:** in Ordis's database volume on your server. Download one now and then so a copy also survives your host going down.

**Automatic alerts** (in the `/setup alerts` channel): new daily sortie, weekly Archon Hunt, Baro Ki'Teer's arrival
with inventory, Steel Path reward rotation, in-game alerts, and invasions offering Orokin Catalysts/Reactors, Forma,
Exilus Adapters or Wraith/Vandal parts. Each alert is posted once (tracked in the database across restarts).

Feature ideas borrowed from community tools: Genesis/WFCD (world-state commands, trackers), Warframe Hub (personal
notifications), warframestat.us (item and drop data) and the wiki.

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN`.
   Only if you want welcome messages: enable **Server Members Intent** there and set `ENABLE_WELCOME=true`.
3. Invite it to the clan server (replace `APP_ID` with the Application ID from **General Information**):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=84992`
   (View Channels, Send Messages, Embed Links, Read Message History). To ping a role that isn't
   "mentionable", also give the bot **Mention @everyone, @here, and All Roles**.
4. Copy the server ID (Discord settings → Advanced → Developer Mode, then right-click the server) into `DISCORD_GUILD_ID`.

Slash commands are registered to that server automatically on startup. Then run `/setup alerts` and `/setup announcements`.

**Name and avatar:** on startup the bot renames itself to `BOT_NAME` (default `Cephalon Ordis`) and uploads
`assets/clan-logo.png` as its avatar. It only sends a change when something differs, because Discord allows just
a couple of changes per hour. To change the logo, replace that file and ship a new image. The application name in
the Developer Portal (General Information → Name) is separate: set it to `Cephalon Ordis` there too.

### Optional: Claude-powered chat

The free answers above handle the common questions. To get real conversations instead (follow-up questions,
explaining builds and mechanics in its own words), set `ANTHROPIC_API_KEY` to a Claude API key from
<https://platform.claude.com>. This is billed per question by Anthropic and is separate from a Claude subscription.
Leave it empty to stay free.

- **Model:** Claude Opus 5.5 by default. Set `AI_MODEL` to `claude-sonnet-5-5` or `claude-haiku-5-5` for cheaper answers.
- **Refusal fallbacks:** on Opus and Sonnet, the bot sends Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a
  declined request is retried on a suitable model instead of failing.
- **Spend limits:** `AI_USER_HOURLY_LIMIT` (default 20 questions per member per hour) and `AI_DAILY_LIMIT` (default 300 per UTC day).
  The system prompt and tools are prompt-cached. Every answer logs its token use (`[ai] … in= cache_read= out=`) in the container log.
- **Privileged intents:** none needed. Discord gives bots the text of messages that mention them and of DMs. For a `/setup chat`
  channel where Ordis reads *every* message, enable **Message Content Intent** in the Developer Portal and set
  `ENABLE_MESSAGE_CONTENT=true`.
- **DMs:** only clan server members can DM Ordis questions.

## 2. Configure

Copy `.env.example` to `.env` and fill it in. Required: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`.
Set `MCP_AUTH_TOKEN` (24+ characters) to enable the MCP endpoint:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Run

### Docker stack (recommended)

`docker-compose.yml` is the full production stack:

| Service | Image | Role |
| --- | --- | --- |
| `bot` | `$DOCKERHUB_IMAGE:$BOT_TAG` | The bot and MCP server. SQLite database in the `bot-data` volume |
| `caddy` | `caddy:2-alpine` | Public HTTPS for `https://$BOT_DOMAIN/mcp` with automatic Let's Encrypt certificates |
| `watchtower` | `nickfedor/watchtower:1` | Checks Docker Hub every `WATCHTOWER_POLL_INTERVAL` seconds and restarts the bot on a new image |

The bot image is built by GitHub Actions for `linux/amd64` and `linux/arm64`, so a Raspberry Pi works.

1. Point a DNS record (`BOT_DOMAIN`) at the server and open ports **80** and **443**.
2. Next to `docker-compose.yml`, copy `.env.example` to `.env` and fill it in. Required: `DISCORD_TOKEN`,
   `DISCORD_GUILD_ID`, `DOCKERHUB_IMAGE` and `BOT_DOMAIN`. Also set `MCP_AUTH_TOKEN` and
   `MCP_ALLOWED_HOSTS=<BOT_DOMAIN>,localhost,127.0.0.1`.
3. Start it:

   ```bash
   docker compose up -d
   ```

**Portainer:** create a stack from this repository (compose path `docker-compose.yml`) or paste the file. Then
enter the same variables under *Environment variables*. Nothing else needs to be on the host.

**Release flow:** merging to `main` publishes `:latest`, and Watchtower rolls it out within a few minutes.
Set `BOT_TAG` to a version such as `1.2.0` to stay on that release. Watchtower only touches the `bot` container,
because it is the only one with the `com.centurylinklabs.watchtower.enable` label. If the Docker Hub
repository is private, mount a `config.json` with registry credentials into Watchtower.

The bot also listens on `127.0.0.1:3000` on the host itself, for health checks and a Claude Code running on the
server. Watchtower needs the Docker socket, which gives root-level access to the host. Remove the service if
you'd rather update with `docker compose pull && docker compose up -d`.

### Locally

Requires Node.js 24+.

```bash
npm ci
npm run dev
```

## Web endpoints

The bot's HTTP port (3000 in the container) serves:

| Path | What |
| --- | --- |
| `/` | Status page: logo, online status and ping, clan stats, current open-world cycles with live countdowns, upcoming events (titles and RSVP counts only). Refreshes itself |
| `/status.json` | The same data as JSON |
| `/health` | `{"status":"ok","discord":true}` once connected to Discord (used by the Docker health check) |
| `/mcp` | MCP endpoint (below), only when `MCP_AUTH_TOKEN` is set |

The status page shows no member names or Discord IDs. Anyone who can reach the URL can see it, so keep it behind
Cloudflare Access if your event titles are private.

## MCP server

`POST /mcp` speaks MCP over Streamable HTTP and requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.

| Tool | Kind |
| --- | --- |
| `get_worldstate`, `get_fissures`, `lookup_item`, `price_check`, `search_drops`, `search_wiki` | Warframe data (read-only) |
| `get_clan_overview`, `list_clan_members`, `list_channels_and_roles`, `list_events` | Clan & Discord info (read-only) |
| `create_event`, `cancel_event`, `send_announcement` | Post to Discord |
| `register_member`, `remove_member` | Edit the clan roster |

**Claude Code** — this repo ships a project `.mcp.json`. Export the token before starting Claude Code. With the
Docker stack, also export the public URL `https://<BOT_DOMAIN>/mcp`, since the default is
`http://localhost:3000/mcp`. Then approve the `cephalon-ordis` server when prompted:

```bash
export RATS_DEN_MCP_TOKEN=<your MCP_AUTH_TOKEN>
```

```bash
export RATS_DEN_MCP_URL=https://bot.example.com/mcp
```

Or add it to any project/user scope by hand:

```bash
claude mcp add --transport http cephalon-ordis https://bot.example.com/mcp --header "Authorization: Bearer <token>"
```

## CI/CD

`.github/workflows/docker-publish.yml` runs typecheck + tests, then builds the multi-arch image:

- push to `main` → `:latest` and `:sha-<short>`
- tag `v1.2.3` → `:1.2.3`, `:1.2` and `:sha-<short>`
- pull requests → build only, nothing pushed

It uses the repository secrets `DOCKER_USERNAME` and `DOCKER_PASSWORD` (preferably a Docker Hub access token with
read/write scope rather than the account password). The image name defaults to `<DOCKER_USERNAME>/rats-den-warframe-bot`; set a repository
**variable** `DOCKERHUB_IMAGE` to override it.

## Data sources

- World state: Digital Extremes' official feed (`api.warframe.com/cdn/worldState.php`), parsed locally with
  [`warframe-worldstate-parser`](https://github.com/WFCD/warframe-worldstate-parser)
- Prices: [warframe.market](https://warframe.market) API v2
- Drop tables and item data: [warframestat.us](https://docs.warframestat.us)
- Wiki summaries: [wiki.warframe.com](https://wiki.warframe.com) (MediaWiki API)
- AI chat: [Claude API](https://platform.claude.com) (Anthropic)

Not affiliated with Digital Extremes.
