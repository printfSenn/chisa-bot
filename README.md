# chisa bot

tsundere discord bot. she talks when she wants to.

## setup

1. get a discord bot token from discord.com/developers
2. get a free groq key from console.groq.com
3. boom summon .env and fill in
4. npm install
5. node bot.js

## thats it

change CHANCE in bot.js if shes too quiet or too loud. 0.6 is my pick idk more noise more noice

# zeta bot

hololive wife bot. she loves senn and she's not shy about it.

## setup

1. get a discord bot token from discord.com/developers
2. get a free mistral key from console.mistral.ai
3. get a supabase project from supabase.com (free tier works)
4. get a weather key from openweathermap.org (optional)
5. create .env and fill in
6. npm install
7. node zeta-bot.js

## env

```
DISCORD_TOKEN_ZETA=
MISTRAL_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
WEATHER_KEY=
```

## supabase tables

run this in your supabase sql editor:

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

## what she does

- talks to senn unprompted. change the 0.6 in zeta-bot.js if shes too clingy or too quiet
- remembers things about people across sessions
- slash commands for trivia, polls, ship, 8ball, would you rather, translate, diary, afk and more
- reacts to chisa (the other bot) when she feels like it
- sends a good morning message every day at 7am WIB
- teases senn if hes up past midnight

## thats it
