# 🐀 The Rats Den 69 — Warframe clan bot

Discord companion bot for the Warframe clan **The Rats Den 69**: live world state, market prices, drop tables,
a clan roster, events with RSVPs, LFG squads, automatic alerts, and an **MCP server** so AI assistants
(Claude Code, Claude Desktop, …) can read Warframe data and manage the clan.

## Features

| Command | What it does |
| --- | --- |
| `/wf cycles · fissures · sortie · archon · baro · steelpath · invasions · nightwave` | Live world state (fissures filter by tier / Steel Path / Void Storm) |
| `/price item` | warframe.market cheapest online sellers & top buyers, with a ready-to-paste whisper (autocomplete) |
| `/drops item` | Where an item, mod or relic drops, with chances |
| `/clan info · register · unregister · whois · roster` | Link Discord members to in-game names, MR and platform |
| `/event create · list · cancel` | Clan events with ✅ / 🤔 / ❌ RSVP buttons and a reminder ping 15 min before start |
| `/lfg activity [details] [size]` | Squad post with Join / Leave / Close buttons; pings everyone when full |
| `/setup alerts · announcements · welcome · off · show` | (Manage Server) choose channels and the alert ping role |

**Automatic alerts** (in the `/setup alerts` channel): new daily sortie, weekly Archon Hunt, Baro Ki'Teer's arrival
with inventory, Steel Path reward rotation, in-game alerts, and invasions offering Orokin Catalysts/Reactors, Forma,
Exilus Adapters or Wraith/Vandal parts. Each alert is posted once (tracked in the database across restarts).

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

## 2. Configure

Copy `.env.example` to `.env` and fill it in. Required: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`.
Set `MCP_AUTH_TOKEN` (24+ characters) to enable the MCP endpoint:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Run

### Docker (recommended)

Images are published to Docker Hub by GitHub Actions (`linux/amd64` and `linux/arm64`, so a Raspberry Pi works).

```bash
DOCKERHUB_IMAGE=<dockerhub-user>/rats-den-warframe-bot docker compose up -d
```

The SQLite database lives in the `bot-data` volume (`/app/data`). The container exposes port 3000 for
`/health` and `/mcp`; compose binds it to `127.0.0.1` only. Put a TLS reverse proxy (Caddy, Traefik, nginx,
Cloudflare Tunnel) in front if you want to reach MCP from other machines, and set `MCP_ALLOWED_HOSTS` to
that hostname.

### Locally

Requires Node.js 24+.

```bash
npm ci
npm run dev
```

## MCP server

`POST /mcp` speaks MCP over Streamable HTTP and requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.

| Tool | Kind |
| --- | --- |
| `get_worldstate`, `get_fissures`, `price_check`, `search_drops` | Warframe data (read-only) |
| `get_clan_overview`, `list_clan_members`, `list_channels_and_roles`, `list_events` | Clan & Discord info (read-only) |
| `create_event`, `cancel_event`, `send_announcement` | Post to Discord |
| `register_member`, `remove_member` | Edit the clan roster |

**Claude Code** — this repo ships a project `.mcp.json`. Export the token (and the URL, if the bot isn't on
`localhost:3000`) before starting Claude Code, then approve the `rats-den-bot` server when prompted:

```bash
export RATS_DEN_MCP_TOKEN=<your MCP_AUTH_TOKEN>
export RATS_DEN_MCP_URL=https://bot.example.com/mcp
```

Or add it to any project/user scope by hand:

```bash
claude mcp add --transport http rats-den-bot https://bot.example.com/mcp --header "Authorization: Bearer <token>"
```

## CI/CD

`.github/workflows/docker-publish.yml` runs typecheck + tests, then builds the multi-arch image:

- push to `main` → `:latest` and `:sha-<short>`
- tag `v1.2.3` → `:1.2.3`, `:1.2` and `:sha-<short>`
- pull requests → build only, nothing pushed

It uses the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with
read/write scope). The image name defaults to `<DOCKERHUB_USERNAME>/rats-den-warframe-bot`; set a repository
**variable** `DOCKERHUB_IMAGE` to override it.

## Data sources

- World state: Digital Extremes' official feed (`api.warframe.com/cdn/worldState.php`), parsed locally with
  [`warframe-worldstate-parser`](https://github.com/WFCD/warframe-worldstate-parser)
- Prices: [warframe.market](https://warframe.market) API v2
- Drop tables: [warframestat.us](https://docs.warframestat.us)

Not affiliated with Digital Extremes.
