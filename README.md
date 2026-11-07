# Zeta Discord Bot

Zeta is a Discord bot built with Node.js and discord.js. It combines conversational replies with practical server utilities, persistent memories, chat activity tracking, lightweight games, scheduled messages, and slash commands.

The production entrypoint is `zeta-bot.js`. `bot.js` is an older standalone Chisa/Groq prototype kept for reference and is not started by the current package scripts.

## Features

- Conversational replies with short-term channel context and optional user memories
- OpenAI-compatible chat completion providers, including Mistral, Groq, OpenAI, OpenRouter, and custom endpoints
- Slash commands for utilities: trivia, polls, reminders, translation, calculations, quotes, AFK status, and summaries
- PostgreSQL-backed memories, quotes, AFK records, and activity leaderboards
- A small RPG economy with daily rewards, work, hunting, adventures, inventory, and leaderboards
- Scheduled random messages and configurable morning greetings
- Optional weather lookups and lightweight web-based information lookups

## Requirements

- Node.js 20 or newer
- A Discord application with a bot token and the required Gateway intents enabled
- An API key for an OpenAI-compatible chat completion endpoint
- PostgreSQL for persistence (optional for local demos)

## Local setup

```bash
git clone <repository-url>
cd Chisa
npm install
copy .env.example .env
npm start
```

On macOS/Linux, use `cp .env.example .env` instead of `copy`.

Never commit `.env`, API keys, bot tokens, `node_modules/`, or runtime save files.

## Environment variables

The recommended AI configuration is provider-neutral:

```env
DISCORD_TOKEN_ZETA=
AI_PROVIDER=mistral
AI_API_KEY=
AI_BASE_URL=https://api.mistral.ai/v1
AI_MODEL=mistral-small-latest
AI_MAX_TOKENS=300
```

`AI_BASE_URL` must expose a `/chat/completions` endpoint. For Groq, for example, use `https://api.groq.com/openai/v1` and a Groq-supported model. Existing deployments using `MISTRAL_API_KEY` continue to work without changes; OpenAI-style `sk-...` values in that legacy variable are detected as OpenAI-compatible credentials. For any other provider, set `AI_PROVIDER`, `AI_BASE_URL`, and `AI_MODEL` explicitly.

For a no-cost development setup with Groq, use `AI_PROVIDER=groq`, a `gsk_...` key, and `AI_MODEL=openai/gpt-oss-120b`. Free tiers are rate-limited, so avoid enabling frequent random messages during testing.

`DATABASE_URL` is optional; `POSTGRES_URL` and `NEON_DATABASE_URL` are also accepted. Without a database, the bot starts in local/demo mode and reports that persistence features are unavailable. `WEATHER_KEY` is also optional. Channel IDs can be configured with the `ZETA_*_CHANNEL_IDS` variables in `.env.example`, or per server with the channel setup commands.

## Database

The bot creates its tables on startup when `DATABASE_URL` is available. For a fresh PostgreSQL database, the core schema is:

```sql
create table memories (
  id bigint generated always as identity primary key,
  user_id text,
  guild_id text,
  content text,
  created_at timestamptz default now()
);

create table quotes (
  id bigint generated always as identity primary key,
  guild_id text,
  text text,
  author text,
  saved_by text,
  created_at timestamptz default now()
);
```

AFK, activity, and game-related state are initialized by the bot as needed. Use a managed PostgreSQL provider for a deployed bot so data survives restarts.

## Deployment notes

Discord bots need a continuously running worker; a request-only or sleeping web service is not sufficient. Configure the start command as:

```bash
npm start
```

The included `Procfile` uses the same worker command for platforms that support Procfile-based deployment. Keep secrets in the platform's environment-variable manager, not in Git. Local game and channel-setting files are intentionally ignored because ephemeral hosts may lose them after a restart; use PostgreSQL for data that must persist.

## Project structure

| File | Purpose |
| --- | --- |
| `zeta-bot.js` | Active Discord bot and command handlers |
| `bot.js` | Legacy Chisa/Groq prototype |
| `package.json` | Runtime metadata and start script |
| `Procfile` | Worker command for compatible hosts |
| `.env.example` | Safe configuration template |

## Validation

```bash
node --check zeta-bot.js
npm start
```

For a portfolio demo, run the bot locally with a test Discord server and a disposable API key. For a public deployment, add a managed database and a host that supports an always-on worker.
