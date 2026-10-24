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

## MCP server

`POST /mcp` speaks MCP over Streamable HTTP and requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.

| Tool | Kind |
| --- | --- |
| `get_worldstate`, `get_fissures`, `price_check`, `search_drops` | Warframe data (read-only) |
| `get_clan_overview`, `list_clan_members`, `list_channels_and_roles`, `list_events` | Clan & Discord info (read-only) |
| `create_event`, `cancel_event`, `send_announcement` | Post to Discord |
| `register_member`, `remove_member` | Edit the clan roster |

**Claude Code** — this repo ships a project `.mcp.json`. Export the token before starting Claude Code. With the
Docker stack, also export the public URL `https://<BOT_DOMAIN>/mcp`, since the default is
`http://localhost:3000/mcp`. Then approve the `rats-den-bot` server when prompted:

```bash
export RATS_DEN_MCP_TOKEN=<your MCP_AUTH_TOKEN>
```

```bash
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

It uses the repository secrets `DOCKER_USERNAME` and `DOCKER_PASSWORD` (preferably a Docker Hub access token with
read/write scope rather than the account password). The image name defaults to `<DOCKER_USERNAME>/rats-den-warframe-bot`; set a repository
**variable** `DOCKERHUB_IMAGE` to override it.

## Data sources

- World state: Digital Extremes' official feed (`api.warframe.com/cdn/worldState.php`), parsed locally with
  [`warframe-worldstate-parser`](https://github.com/WFCD/warframe-worldstate-parser)
- Prices: [warframe.market](https://warframe.market) API v2
- Drop tables: [warframestat.us](https://docs.warframestat.us)

Not affiliated with Digital Extremes.
