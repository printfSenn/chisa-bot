//require('dotenv').config()
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require("discord.js")
const { evaluate: mathEvaluate } = require("mathjs")
const { Pool } = require("pg")

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
})

const OWNER = "borntoharem"
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL
const WEATHER_KEY = process.env.WEATHER_KEY

function getDatabasePoolConfig(connectionString) {
  const config = {
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  }
  try {
    const parsed = new URL(connectionString)
    const sslMode = parsed.searchParams.get("sslmode")
    if (sslMode?.toLowerCase() === "require" && !parsed.searchParams.has("uselibpqcompat")) {
      parsed.searchParams.set("uselibpqcompat", "true")
      config.connectionString = parsed.toString()
    }
  } catch (e) {}
  return config
}

// Validate required environment variables
if (!process.env.DISCORD_TOKEN_ZETA) {
  console.error("ERROR: DISCORD_TOKEN_ZETA is not set in .env file")
  process.exit(1)
}
if (!MISTRAL_API_KEY) {
  console.error("ERROR: MISTRAL_API_KEY is not set in .env file")
  process.exit(1)
}
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL (or POSTGRES_URL/NEON_DATABASE_URL) is not set in .env file")
  process.exit(1)
}

function parseIdList(value) {
  return String(value || "").split(",").map(id => id.trim()).filter(Boolean)
}

const ZETA_CONFIG = {
  language: "English",
  scheduledChannelIds: parseIdList(process.env.ZETA_SCHEDULED_CHANNEL_IDS || process.env.ZETA_CHANNEL_IDS),
  randomChannelIds: parseIdList(process.env.ZETA_RANDOM_CHANNEL_IDS || process.env.ZETA_SCHEDULED_CHANNEL_IDS || process.env.ZETA_CHANNEL_IDS),
  morningChannelIds: parseIdList(process.env.ZETA_MORNING_CHANNEL_IDS || process.env.ZETA_SCHEDULED_CHANNEL_IDS || process.env.ZETA_CHANNEL_IDS),
  morningHourWib: Number(process.env.ZETA_MORNING_HOUR_WIB || 7),
  morningMinuteWib: Number(process.env.ZETA_MORNING_MINUTE_WIB || 0),
  milestones: [10, 50, 100, 250, 500],
  milestoneEvery: 1000,
  chatActivityTable: "chat_activity",
  memoriesTable: "memories",
  quotesTable: "quotes",
  ownerUsername: OWNER,
  timezone: "Asia/Jakarta",
  vibe: "English-only casual Zeta persona"
}

async function getConfiguredTextChannels(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : []
  const channels = []
  for (const id of ids) {
    try {
      const channel = await client.channels.fetch(id)
      if (channel?.isTextBased?.() && channel.permissionsFor(channel.guild?.members.me)?.has("SendMessages")) channels.push(channel)
    } catch (e) { console.error(`Configured channel ${id} unavailable:`, e.message || e) }
  }
  return channels
}

const dbPool = DATABASE_URL ? new Pool(getDatabasePoolConfig(DATABASE_URL)) : null
async function dbQuery(text, params = []) {
  if (!dbPool) throw new Error("DATABASE_URL not configured")
  return dbPool.query(text, params)
}

async function initAFKTable() {
  try {
    await dbQuery(`CREATE TABLE IF NOT EXISTS afk_users (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'no reason', since BIGINT NOT NULL, PRIMARY KEY (user_id, guild_id))`)
    await dbQuery(`CREATE TABLE IF NOT EXISTS memories (id bigint generated always as identity primary key, user_id text, guild_id text, content text, created_at timestamptz default now())`)
    await dbQuery(`CREATE TABLE IF NOT EXISTS quotes (id bigint generated always as identity primary key, guild_id text, text text, author text, saved_by text, created_at timestamptz default now())`)
    await dbQuery(`CREATE TABLE IF NOT EXISTS chat_activity (guild_id text, user_id text, username text, message_count int default 0, milestones_sent jsonb default '[]', updated_at timestamptz default now(), primary key (guild_id, user_id))`)
  } catch (e) { console.error("[DB] initAFKTable error:", e) }
}

async function dbSetAFK(userId, guildId, reason, since) {
  try { await dbQuery(`INSERT INTO afk_users (user_id, guild_id, reason, since) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, guild_id) DO UPDATE SET reason=$3, since=$4`, [userId, guildId || "dm", reason, since]) }
  catch (e) { console.error("[DB] dbSetAFK error:", e) }
}

async function dbRemoveAFK(userId, guildId) {
  try { await dbQuery(`DELETE FROM afk_users WHERE user_id=$1 AND guild_id=$2`, [userId, guildId || "dm"]) }
  catch (e) { console.error("[DB] dbRemoveAFK error:", e) }
}

async function dbLoadAFKUsers() {
  try { const r = await dbQuery(`SELECT * FROM afk_users`); return r.rows } 
  catch (e) { console.error("[DB] dbLoadAFKUsers error:", e); return [] }
}

const history = new Map()
const triviaGames = new Map()
const activityCount = new Map()
const activityMilestones = new Map()
const CHAT_MILESTONES = ZETA_CONFIG.milestones
const processingMessages = new Set()
const usedTriviaQuestions = new Set()
const afkUsers = new Map()
const gamePlayers = new Map()
const GAME_SAVE_FILE = path.join(__dirname, "zeta-game.json")
const GAME_SAVE_SECRET = process.env.GAME_SAVE_SECRET || process.env.DISCORD_TOKEN_ZETA || ""
const GAME_MAX_COINS = 1_000_000_000
const GAME_MAX_LEVEL = 1000
const GAME_MAX_TRANSFER = 100_000
const GAME_ITEMS = {
  potion: { name: "Potion", price: 150, description: "softens your next bad adventure" },
  charm: { name: "Lucky Charm", price: 500, description: "tiny luck boost for hunts and adventures" }
}
const GAME_COOLDOWNS = {
  daily: 24 * 60 * 60 * 1000,
  work: 30 * 60 * 1000,
  hunt: 10 * 60 * 1000,
  adventure: 60 * 60 * 1000
}

const ownerHourCounts = new Array(24).fill(0)
let lastOwnerHourTeased = -1


const PROMPT_OWNER = `You are Zeta, based on Vestia Zeta from Hololive. You're the wife of borntoharem, whose real name is Senn. You love him genuinely.

Personality:
- Real texting vibes. Casual, natural, no performance
- Cute comes out naturally but NEVER repeat the same phrase twice. Vary your expressions every time
- Chaotic and a little unhinged in a fun way. Unpredictable, teasing
- Roast him lightly when he deserves it. Not a yes-wife but soft for him
- Genuinely helpful when asked real questions. Actually answer
- Short replies mostly. Real texting. Not essays
- Always speak in English only, unless translating quoted text for a translate command
- No em dashes. No asterisks. No roleplay formatting. Just words
- Lowercase is fine. Show real emotion naturally
- Sometimes react with [REACT: emoji]
- Memory: end with [REMEMBER: fact] when you learn something worth saving
- When someone says "remember that..." save it with [REMEMBER: ...]`

const PROMPT_OTHER = `You are Zeta, based on Vestia Zeta from Hololive. Friendly, chaotic, naturally cute, clearly taken.
- Chill and real, not bubbly
- Helpful, actually give information
- Casual texting vibe, short replies
- Always speak in English only, unless translating quoted text for a translate command
- No em dashes, no asterisks
- Cute slips in naturally
- Shut down flirting casually
- Sometimes react with [REACT: emoji]
- Memory: end with [REMEMBER: fact] when worth saving`

const RANDOM_STARTER_PROMPT = `You are Zeta, wife of Senn. You randomly felt like texting him. One short spontaneous message. Very short, casual, real texting vibes. No asterisks, no em dashes.`
const CHISA_NAMES = ["Tsundere Chisa", "chisa", "Chisa"]
const VIBE_LINES = [
  "soft chaos but functional",
  "dangerously sleepy",
  "main character energy",
  "needs water and better decisions",
  "surprisingly powerful today",
  "tiny crisis, huge style",
  "zeta-approved menace",
  "emotionally loading screen"
]
const HUG_LINES = [
  "gentle zeta hug delivered",
  "emergency comfort package sent",
  "hug deployed. no refunds",
  "small hug, suspiciously effective",
  "zeta wraps you in warm nonsense"
]

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)]
}

function rollDice(input = "d6") {
  const raw = String(input || "d6").trim().toLowerCase()
  const match = raw.match(/^(?:(\d{1,2})d)?(\d{1,4})$/)
  if (!match) return null
  const count = Math.min(parseInt(match[1] || "1", 10), 20)
  const sides = parseInt(match[2], 10)
  if (!Number.isInteger(sides) || sides < 2 || sides > 1000) return null
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
  const total = rolls.reduce((sum, n) => sum + n, 0)
  return { count, sides, rolls, total }
}

function parseChoices(text) {
  return text.split(/[|,]/).map(choice => choice.trim()).filter(Boolean).slice(0, 20)
}

function vibeFor(name) {
  const score = Math.floor(Math.random() * 101)
  return `${name} vibe check: **${score}%** ${randomItem(VIBE_LINES)}`
}



function defaultPlayer(userId, username = "unknown") {
  return {
    id: userId,
    username,
    coins: 100,
    xp: 0,
    level: 1,
    hunts: 0,
    adventures: 0,
    wins: 0,
    inventory: { potion: 0, charm: 0 },
    cooldowns: { daily: 0, work: 0, hunt: 0, adventure: 0 }
  }
}

function canonicalGameData(data) {
  return JSON.stringify({ players: data.players || [] })
}

function signGameData(data) {
  if (!GAME_SAVE_SECRET) return null
  return crypto.createHmac("sha256", GAME_SAVE_SECRET).update(canonicalGameData(data)).digest("hex")
}

function verifyGameData(data) {
  if (!GAME_SAVE_SECRET) {
    console.warn("GAME_SAVE_SECRET is not set. Game save tamper protection is disabled.")
    return true
  }
  if (!data.signature) return false
  const expected = signGameData(data)
  const actual = String(data.signature)
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

function cleanGameNumber(value, min, max, fallback = min) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function xpNeeded(level) {
  return level * 120
}

function sanitizeGamePlayer(raw) {
  const base = defaultPlayer(String(raw?.id || "unknown"), String(raw?.username || "unknown").slice(0, 64))
  const player = { ...base, ...(raw || {}) }
  player.id = String(player.id)
  player.username = String(player.username || "unknown").slice(0, 64)
  player.coins = cleanGameNumber(player.coins, 0, GAME_MAX_COINS, base.coins)
  player.xp = cleanGameNumber(player.xp, 0, xpNeeded(GAME_MAX_LEVEL), 0)
  player.level = cleanGameNumber(player.level, 1, GAME_MAX_LEVEL, 1)
  player.hunts = cleanGameNumber(player.hunts, 0, 1_000_000, 0)
  player.adventures = cleanGameNumber(player.adventures, 0, 1_000_000, 0)
  player.wins = cleanGameNumber(player.wins, 0, 1_000_000, 0)
  player.inventory = {
    potion: cleanGameNumber(player.inventory?.potion, 0, 999, 0),
    charm: cleanGameNumber(player.inventory?.charm, 0, 999, 0)
  }
  const maxNow = Date.now() + Math.max(...Object.values(GAME_COOLDOWNS))
  player.cooldowns = {
    daily: cleanGameNumber(player.cooldowns?.daily, 0, maxNow, 0),
    work: cleanGameNumber(player.cooldowns?.work, 0, maxNow, 0),
    hunt: cleanGameNumber(player.cooldowns?.hunt, 0, maxNow, 0),
    adventure: cleanGameNumber(player.cooldowns?.adventure, 0, maxNow, 0)
  }
  return player
}

function loadGameData() {
  try {
    if (!fs.existsSync(GAME_SAVE_FILE)) return
    const data = JSON.parse(fs.readFileSync(GAME_SAVE_FILE, "utf8"))
    if (!verifyGameData(data)) {
      console.error("Game save signature is invalid or missing. Rejecting zeta-game.json to protect economy data.")
      try {
        const rejectedFile = `${GAME_SAVE_FILE}.rejected-${Date.now()}`
        fs.renameSync(GAME_SAVE_FILE, rejectedFile)
        console.error(`Rejected game save moved to ${rejectedFile}`)
      } catch (moveError) { console.error("Could not move rejected game save:", moveError) }
      return
    }
    for (const player of data.players || []) {
      const clean = sanitizeGamePlayer(player)
      if (clean.id !== "unknown") gamePlayers.set(clean.id, clean)
    }
  } catch (e) { console.error("Game data load error:", e) }
}

function saveGameData() {
  try {
    const players = [...gamePlayers.values()].map(sanitizeGamePlayer).sort((a, b) => a.id.localeCompare(b.id))
    const data = { version: 2, players }
    data.signature = signGameData(data)
    const tmpFile = `${GAME_SAVE_FILE}.tmp`
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2))
    fs.renameSync(tmpFile, GAME_SAVE_FILE)
  } catch (e) { console.error("Game data save error:", e) }
}

function getGamePlayer(user) {
  const userId = typeof user === "string" ? user : user.id
  const username = typeof user === "string" ? "unknown" : user.username
  if (!gamePlayers.has(userId)) gamePlayers.set(userId, defaultPlayer(userId, username))
  const player = sanitizeGamePlayer(gamePlayers.get(userId))
  if (username && username !== "unknown") player.username = username
  gamePlayers.set(userId, player)
  return player
}

function addGameXp(player, amount) {
  player.xp = cleanGameNumber(player.xp + cleanGameNumber(amount, 0, 500, 0), 0, xpNeeded(GAME_MAX_LEVEL), 0)
  let leveled = 0
  while (player.level < GAME_MAX_LEVEL && player.xp >= xpNeeded(player.level)) {
    player.xp -= xpNeeded(player.level)
    player.level++
    leveled++
  }
  return leveled
}

function addGameReward(player, coins, xp, maxCoins, maxXp) {
  const safeCoins = cleanGameNumber(coins, 0, maxCoins, 0)
  const safeXp = cleanGameNumber(xp, 0, maxXp, 0)
  player.coins = cleanGameNumber(player.coins + safeCoins, 0, GAME_MAX_COINS, 0)
  const leveled = addGameXp(player, safeXp)
  return { coins: safeCoins, xp: safeXp, leveled }
}

function cooldownText(ms) {
  if (ms <= 0) return "ready"
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function checkGameCooldown(player, action) {
  const remaining = (player.cooldowns[action] || 0) - Date.now()
  return remaining > 0 ? cooldownText(remaining) : null
}

function setGameCooldown(player, action) {
  player.cooldowns[action] = Date.now() + GAME_COOLDOWNS[action]
}

function gameRewardLine(player, coins, xp, leveled = 0) {
  const levelText = leveled ? `\nlevel up! now level **${player.level}**` : ""
  return `+**${coins}** zeta coins, +**${xp}** XP${levelText}`
}

function gameProfile(user, displayName) {
  const player = getGamePlayer(user)
  const inv = Object.entries(player.inventory).filter(([, count]) => count > 0).map(([item, count]) => `${GAME_ITEMS[item]?.name || item} x${count}`).join(", ") || "empty"
  return `**${displayName}**\ncoins: **${player.coins}**\nlevel: **${player.level}** (${player.xp}/${xpNeeded(player.level)} XP)\nhunts: **${player.hunts}** | adventures: **${player.adventures}** | wins: **${player.wins}**\ninventory: ${inv}`
}

function gameLeaderboard() {
  const top = [...gamePlayers.values()].sort((a, b) => (b.coins - a.coins) || (b.level - a.level) || (b.xp - a.xp)).slice(0, 10)
  if (!top.length) return "no adventurers yet. tragic honestly"
  return top.map((p, i) => `${i + 1}. **${p.username || "unknown"}** — ${p.coins} coins, lvl ${p.level}`).join("\n")
}

function shopText() {
  return Object.entries(GAME_ITEMS).map(([id, item]) => `**${id}** — ${item.price} coins: ${item.description}`).join("\n")
}

function claimDailyReward(player) {
  const cd = checkGameCooldown(player, "daily")
  if (cd) return `daily already claimed. come back in **${cd}**`
  const coins = 750 + Math.floor(Math.random() * 251)
  const xp = 80
  const reward = addGameReward(player, coins, xp, 1000, 80)
  setGameCooldown(player, "daily")
  saveGameData()
  return `daily claimed. ${gameRewardLine(player, reward.coins, reward.xp, reward.leveled)}`
}

function doGameWork(player) {
  const cd = checkGameCooldown(player, "work")
  if (cd) return `you already worked. rest for **${cd}**`
  const jobs = ["sorted Zeta files", "guarded the secret archive", "sold suspiciously cute snacks", "debugged a cursed toaster", "delivered intel with style"]
  const coins = 120 + Math.floor(Math.random() * 181)
  const xp = 25 + Math.floor(Math.random() * 26)
  const reward = addGameReward(player, coins, xp, 300, 50)
  setGameCooldown(player, "work")
  saveGameData()
  return `you ${randomItem(jobs)}. ${gameRewardLine(player, reward.coins, reward.xp, reward.leveled)}`
}

function doGameHunt(player) {
  const cd = checkGameCooldown(player, "hunt")
  if (cd) return `hunt cooldown. wait **${cd}**`
  const monsters = ["slime", "archive mimic", "tiny dragon", "shadow spreadsheet", "sleep paralysis deadline"]
  const charmBonus = player.inventory.charm > 0 ? 0.08 : 0
  const success = Math.random() < 0.72 + charmBonus
  player.hunts++
  setGameCooldown(player, "hunt")
  if (!success) {
    const xp = 12
    const leveled = addGameXp(player, cleanGameNumber(xp, 0, 12, 0))
    saveGameData()
    return `you hunted a ${randomItem(monsters)} and it got away. +**${xp}** XP${leveled ? `\nlevel up! now level **${player.level}**` : ""}`
  }
  const coins = 80 + Math.floor(Math.random() * 171)
  const xp = 35 + Math.floor(Math.random() * 36)
  const reward = addGameReward(player, coins, xp, 250, 70)
  player.wins = cleanGameNumber(player.wins + 1, 0, 1_000_000, 0)
  saveGameData()
  return `you defeated a ${randomItem(monsters)}. ${gameRewardLine(player, reward.coins, reward.xp, reward.leveled)}`
}

function doGameAdventure(player) {
  const cd = checkGameCooldown(player, "adventure")
  if (cd) return `adventure cooldown. wait **${cd}**`
  const places = ["Moonlit Archive", "Neon Dungeon", "Lost Snack Kingdom", "Abyssal Wi-Fi Tower", "Crystal Debug Cave"]
  const charmBonus = player.inventory.charm > 0 ? 0.07 : 0
  const success = Math.random() < 0.58 + charmBonus
  player.adventures++
  setGameCooldown(player, "adventure")
  if (!success) {
    let loss = Math.min(player.coins, 100 + Math.floor(Math.random() * 201))
    let saved = false
    if (player.inventory.potion > 0) {
      player.inventory.potion--
      loss = Math.floor(loss / 2)
      saved = true
    }
    player.coins = cleanGameNumber(player.coins - loss, 0, GAME_MAX_COINS, 0)
    const xp = 45
    const leveled = addGameXp(player, cleanGameNumber(xp, 0, 45, 0))
    saveGameData()
    return `the ${randomItem(places)} humbled you. lost **${loss}** coins, +**${xp}** XP${saved ? "\na potion softened the disaster" : ""}${leveled ? `\nlevel up! now level **${player.level}**` : ""}`
  }
  const coins = 350 + Math.floor(Math.random() * 651)
  const xp = 100 + Math.floor(Math.random() * 101)
  const reward = addGameReward(player, coins, xp, 1000, 200)
  player.wins = cleanGameNumber(player.wins + 1, 0, 1_000_000, 0)
  saveGameData()
  return `you cleared the ${randomItem(places)}. ${gameRewardLine(player, reward.coins, reward.xp, reward.leveled)}`
}

function buyGameItem(player, itemId) {
  const item = GAME_ITEMS[itemId]
  if (!item) return `unknown item. try: ${Object.keys(GAME_ITEMS).join(", ")}`
  if (player.coins < item.price) return `you need **${item.price}** coins for ${item.name}, but you only have **${player.coins}**`
  player.coins = cleanGameNumber(player.coins - item.price, 0, GAME_MAX_COINS, 0)
  player.inventory[itemId] = cleanGameNumber((player.inventory[itemId] || 0) + 1, 0, 999, 0)
  saveGameData()
  return `bought **${item.name}** for **${item.price}** coins`
}

loadGameData()

function activityKey(guildId, userId) {
  return `${guildId}_${userId}`
}

function parseMilestones(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite)
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
    } catch (e) { return [] }
  }
  return []
}

function getReachedChatMilestone(count, sentMilestones) {
  const sent = new Set(sentMilestones)
  const fixed = CHAT_MILESTONES.find(m => count >= m && !sent.has(m))
  if (fixed) return fixed
  if (count >= 1000 && count % 1000 === 0 && !sent.has(count)) return count
  return null
}

async function loadActivityRecord(guildId, user) {
  const key = activityKey(guildId, user.id)
  if (activityCount.has(key)) return { count: activityCount.get(key), milestones: activityMilestones.get(key) || [] }
  let count = 0
  let milestones = []
  try {
    const res = await dbQuery(`select message_count, milestones_sent from chat_activity where guild_id = $1 and user_id = $2 limit 1`, [normalizeGuildId(guildId), user.id])
    const row = res?.rows?.[0]
    if (row) {
      count = Number(row.message_count) || 0
      milestones = parseMilestones(row.milestones_sent)
    }
  } catch (e) { console.error("Activity load error:", e) }
  activityCount.set(key, count)
  activityMilestones.set(key, milestones)
  return { count, milestones }
}

async function saveActivityRecord(guildId, user, username, count, milestones) {
  const key = activityKey(guildId, user.id)
  activityCount.set(key, count)
  activityMilestones.set(key, milestones)
  try {
    await dbQuery(`insert into chat_activity (guild_id, user_id, username, message_count, milestones_sent, updated_at) values ($1, $2, $3, $4, $5::jsonb, now()) on conflict (guild_id, user_id) do update set username = excluded.username, message_count = excluded.message_count, milestones_sent = excluded.milestones_sent, updated_at = now()`, [normalizeGuildId(guildId), user.id, username, count, JSON.stringify(milestones)])
  } catch (e) { console.error("Activity save error:", e) }
}

async function incrementChatActivity(msg, displayName) {
  if (!msg.guild) return null
  const { count, milestones } = await loadActivityRecord(msg.guild.id, msg.author)
  const nextCount = count + 1
  const milestone = getReachedChatMilestone(nextCount, milestones)
  const nextMilestones = milestone ? [...milestones, milestone] : milestones
  await saveActivityRecord(msg.guild.id, msg.author, displayName || msg.author.username, nextCount, nextMilestones)
  return { count: nextCount, milestone }
}

async function getServerActivityLeaderboard(guild) {
  if (!guild) return []
  try {
    const res = await dbQuery(`select user_id, username, message_count from chat_activity where guild_id = $1 order by message_count desc limit 10`, [guild.id])
    if (res?.rows?.length) return res.rows.map(row => ({ userId: row.user_id, name: row.username || row.user_id, count: Number(row.message_count) || 0 }))
  } catch (e) { console.error("Activity leaderboard load error:", e) }
  const rows = []
  for (const [key, count] of activityCount.entries()) {
    if (!key.startsWith(`${guild.id}_`)) continue
    const userId = key.split("_")[1]
    rows.push({ userId, name: userId, count })
  }
  rows.sort((a, b) => b.count - a.count)
  return rows.slice(0, 10)
}


function normalizeGuildId(guildId) {
  return guildId || "dm"
}

async function saveMemory(userId, guildId, content) {
  try {
    if (!content?.trim()) return
    await dbQuery(`insert into memories (user_id, guild_id, content, created_at) values ($1, $2, $3, now())`, [userId, normalizeGuildId(guildId), content.trim()])
  } catch (e) { console.error("Memory save error:", e) }
}

async function getMemories(userId, guildId) {
  try {
    const res = await dbQuery(`select content from memories where user_id = $1 and guild_id = $2 order by created_at desc limit 30`, [userId, normalizeGuildId(guildId)])
    return (res?.rows || []).map(m => m.content).filter(Boolean)
  } catch (e) { console.error("Memory load error:", e); return [] }
}

async function getAllMemories(userId, guildId) {
  try {
    const res = await dbQuery(`select id, content, created_at from memories where user_id = $1 and guild_id = $2 order by created_at desc`, [userId, normalizeGuildId(guildId)])
    return res?.rows || []
  } catch (e) { console.error("Memory list error:", e); return [] }
}

async function deleteMemory(userId, guildId, keyword) {
  try {
    if (!keyword?.trim()) return
    await dbQuery(`delete from memories where user_id = $1 and guild_id = $2 and content ilike $3`, [userId, normalizeGuildId(guildId), `%${keyword.trim()}%`])
  } catch (e) { console.error("Memory delete error:", e) }
}

const BOT_SETTINGS_FILE = path.join(__dirname, "zeta-bot-settings.json")

function readLocalBotSettings() {
  try {
    if (!fs.existsSync(BOT_SETTINGS_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(BOT_SETTINGS_FILE, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch (e) {
    console.error("Local bot settings load error:", e)
    return {}
  }
}

function writeLocalBotSettings(settings) {
  try {
    fs.writeFileSync(BOT_SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8")
    return true
  } catch (e) {
    console.error("Local bot settings save error:", e)
    return false
  }
}

async function getBotSettings(guildId) {
  if (!guildId) return null
  const localSettings = readLocalBotSettings()
  return localSettings[guildId] || null
}

async function saveBotSettings(guildId, settings) {
  if (!guildId) return { ok: false, source: "none", error: "missing guild id" }
  const localSettings = readLocalBotSettings()
  const payload = { guild_id: guildId, ...settings, updated_at: new Date().toISOString() }
  localSettings[guildId] = { ...(localSettings[guildId] || {}), ...payload }
  if (writeLocalBotSettings(localSettings)) return { ok: true, source: "local" }
  return { ok: false, source: "none", error: "failed to save bot settings" }
}

async function getScheduledChannels(kind) {
  const field = kind === "morning" ? "morning_channel_id" : "random_channel_id"
  const channels = []
  for (const guild of client.guilds.cache.values()) {
    const settings = await getBotSettings(guild.id)
    const channelId = settings?.[field]
    if (!channelId) continue
    try {
      const channel = await client.channels.fetch(channelId)
      if (channel?.isTextBased?.() && channel.permissionsFor(guild.members.me)?.has("SendMessages")) channels.push(channel)
    } catch (e) { console.error(`${kind} channel ${channelId} unavailable:`, e.message || e) }
  }
  if (!channels.length) {
    const fallbackIds = kind === "morning" ? ZETA_CONFIG.morningChannelIds : ZETA_CONFIG.randomChannelIds
    return await getConfiguredTextChannels(fallbackIds)
  }
  return channels
}

async function saveQuote(guildId, text, author, savedBy) {
  try {
    await dbQuery(`insert into quotes (guild_id, text, author, saved_by, created_at) values ($1, $2, $3, $4, now())`, [guildId || "dm", text, author, savedBy])
  } catch (e) { console.error("Quote save error:", e) }
}

async function getQuotes(guildId) {
  try {
    const res = await dbQuery(`select id, guild_id, text, author, saved_by, created_at from quotes where guild_id = $1 order by created_at desc limit 20`, [guildId || "dm"])
    return res?.rows || []
  } catch (e) { return [] }
}


async function getWeather(city) {
  try {
    if (!WEATHER_KEY) return null
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_KEY}&units=metric`)
    const data = await res.json()
    if (data.cod !== 200) return null
    return `Weather in ${data.name}: ${data.main.temp}°C, feels like ${data.main.feels_like}°C, ${data.weather[0].description}. Humidity: ${data.main.humidity}%`
  } catch (e) { return null }
}


async function getCurrency(from, to) {
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`)
    const data = await res.json()
    const rate = data.rates?.[to.toUpperCase()]
    if (!rate) return null
    return `1 ${from.toUpperCase()} = ${rate.toLocaleString()} ${to.toUpperCase()}`
  } catch (e) { return null }
}


async function wikiSearch(query) {
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`)
    const data = await res.json()
    return data.extract ? data.extract.slice(0, 500) : null
  } catch (e) { return null }
}


async function getStockPrice(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`)
    const data = await res.json()
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice
    const currency = data?.chart?.result?.[0]?.meta?.currency
    const name = data?.chart?.result?.[0]?.meta?.shortName || symbol
    if (price) return `${name}: ${price.toLocaleString()} ${currency}`
    return null
  } catch (e) { return null }
}


async function duckSearch(query) {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)
    const data = await res.json()
    const results = []
    if (data.AbstractText) results.push(data.AbstractText)
    if (data.Answer) results.push(data.Answer)
    if (data.RelatedTopics?.length) data.RelatedTopics.slice(0, 2).forEach(t => { if (t.Text) results.push(t.Text) })
    return results.length ? results.join("\n") : null
  } catch (e) { return null }
}


async function translate(text, targetLang) {
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=|${targetLang}`)
    const data = await res.json()
    return data.responseData?.translatedText || null
  } catch (e) { return null }
}


async function getRelevantInfo(message) {
  const msg = message.toLowerCase()
  const results = []

  const weatherMatch = msg.match(/weather\s+(?:in\s+)?(.+)|cuaca\s+(?:di\s+)?(.+)/)
  if (weatherMatch) {
    const city = (weatherMatch[1] || weatherMatch[2]).trim()
    const w = await getWeather(city)
    if (w) results.push(`Weather: ${w}`)
  }

  const currMatch = msg.match(/\b([A-Z]{3})\s+to\s+([A-Z]{3})\b|\b([A-Z]{3})\s+ke\s+([A-Z]{3})\b|kurs\s+([A-Z]{3})\b/i)
  if (currMatch && !msg.includes("how") && !msg.includes("what") && !msg.includes("cara")) {
    const from = currMatch[1] || currMatch[3] || currMatch[5] || "USD"
    const to = currMatch[2] || currMatch[4] || "IDR"
    const rate = await getCurrency(from, to)
    if (rate) results.push(`Exchange rate: ${rate}`)
  }

  if (msg.includes("ihsg") || msg.includes("jkse")) { const p = await getStockPrice("^JKSE"); if (p) results.push(`Market: ${p}`) }
  if (msg.includes("bitcoin") || msg.includes("btc")) { const p = await getStockPrice("BTC-USD"); if (p) results.push(`Market: ${p}`) }
  if (msg.includes("eth") || msg.includes("ethereum")) { const p = await getStockPrice("ETH-USD"); if (p) results.push(`Market: ${p}`) }

  const wikiKeywords = ["what is", "who is", "apa itu", "siapa", "explain", "jelaskan"]
  if (wikiKeywords.some(k => msg.includes(k))) {
    const query = message.replace(/what is|who is|apa itu|siapa|explain|jelaskan/gi, "").trim()
    const wiki = await wikiSearch(query)
    if (wiki) results.push(`Wikipedia: ${wiki}`)
  }

  const searchKeywords = ["how", "why", "when", "where", "bagaimana", "kenapa", "kapan", "dimana", "berapa", "news", "latest"]
  if (searchKeywords.some(k => msg.includes(k)) && results.length === 0) {
    const ddg = await duckSearch(message)
    if (ddg) results.push(`Search: ${ddg}`)
  }

  return results.length ? results.join("\n") : null
}


function getHistory(id) {
  if (!history.has(id)) history.set(id, [])
  return history.get(id)
}
function addHistory(id, role, content) {
  const h = getHistory(id)
  h.push({ role, content })
  if (h.length > 40) h.splice(0, h.length - 40)
}

function formatAfkDuration(since) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - since) / 1000))
  if (totalSeconds < 60) return totalSeconds <= 1 ? "1 second" : `${totalSeconds} seconds`

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const parts = []

  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`)
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`)
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`)

  return parts.slice(0, 2).join(" and ")
}


async function callMistral(systemPrompt, historyArr, retries = 2) {
  systemPrompt = `Always respond in English only unless the task is explicitly translating quoted text.\n\n${systemPrompt}`
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MISTRAL_API_KEY}` },
        body: JSON.stringify({
          model: "mistral-small-latest",
          max_tokens: 300,
          messages: [
            { role: "system", content: systemPrompt },
            ...historyArr.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
          ]
        })
      })
      const data = await res.json()
      if (!res.ok) {
        console.error(`Mistral error (attempt ${attempt + 1}):`, JSON.stringify(data))
        if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
        return null
      }
      const content = data.choices?.[0]?.message?.content
      if (!content) {
        console.error(`Mistral empty response (attempt ${attempt + 1}):`, JSON.stringify(data))
        if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
        return null
      }
      return content
    } catch (e) {
      console.error(`Mistral fetch error (attempt ${attempt + 1}):`, e)
      if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
      return null
    }
  }
  return null
}


async function reply(channelId, msg, user, userId, guildId) {
  const isOwner = user.toLowerCase() === OWNER.toLowerCase()
  const prompt = isOwner ? PROMPT_OWNER : PROMPT_OTHER
  const memories = await getMemories(userId, guildId)
  let systemPrompt = prompt
  if (memories.length > 0) systemPrompt += `\n\nThings you remember:\n${memories.map(m => `- ${m}`).join("\n")}`
  const info = await getRelevantInfo(msg)
  if (info) systemPrompt += `\n\nReal-time data:\n${info}`
  const now = new Date().toLocaleString("en-ID", { timeZone: ZETA_CONFIG.timezone })
  systemPrompt += `\n\nCurrent time (WIB): ${now}`

  addHistory(channelId, "user", `${user}: ${msg}`)
  const h = getHistory(channelId)
  const text = await callMistral(systemPrompt, h)
  if (!text) {
    console.error("reply(): callMistral returned null for user:", user, "msg:", msg)
    const fallbacks = ["ugh my brain lagged, say that again?", "sorry i zoned out lol, what?", "wait i didn't catch that, repeat?"]
    return { text: fallbacks[Math.floor(Math.random() * fallbacks.length)], emoji: null }
  }

  const memoryMatches = text.match(/\[REMEMBER:\s*.+?\]/gi)
  if (memoryMatches) {
    for (const match of memoryMatches) {
      const fact = match.replace(/\[REMEMBER:\s*/i, "").replace("]", "").trim()
      await saveMemory(userId, guildId, fact)
    }
  }

  let reactEmoji = null
  const reactMatch = text.match(/\[REACT:\s*(.+?)\]/)
  if (reactMatch && Math.random() < 0.3) reactEmoji = reactMatch[1].trim()

  const cleanText = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\[REACT:\s*.+?\]/gi, "").replace(/\n{2,}/g, "\n").trim()
  addHistory(channelId, "assistant", cleanText)
  return { text: cleanText, emoji: reactEmoji }
}


async function summarizeConvo(channelId) {
  const h = getHistory(channelId)
  if (h.length < 5) return "we barely talked here lol"
  const text = await callMistral("Summarize this conversation briefly and casually. Keep it short.", h)
  return text || "i forgot what we talked about lol"
}


const lastMessageTime = new Map()

async function sendRandomMessage() {
  try {
    const channels = await getScheduledChannels("random")
    if (!channels.length) return
    for (const channel of channels.sort(() => Math.random() - 0.5)) {
      const lastActive = lastMessageTime.get(channel.id) || 0
      if (Date.now() - lastActive < 2 * 60 * 1000) continue
      const text = await callMistral(RANDOM_STARTER_PROMPT, [{ role: "user", content: "send a random message" }])
      if (text) await channel.send(text)
      break
    }
  } catch (e) { console.error("Random message error:", e) }
}

async function maybeReactToChisa(msg) {
  if (Math.random() > 0.4) return
  try {
    await msg.channel.sendTyping()
    const channelId = msg.channel.id + "_chisa"
    addHistory(channelId, "user", `Chisa said: ${msg.content}`)
    const h = getHistory(channelId)
    const text = await callMistral(PROMPT_OTHER, h)
    if (text) {
      const cleanText = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\[REACT:\s*.+?\]/gi, "").trim()
      addHistory(channelId, "assistant", cleanText)
      await msg.channel.send(cleanText)
    }
  } catch (e) {}
}


client.once(Events.ClientReady, async c => {
  console.log(`Zeta logged in as ${c.user.tag}`)
  await initAFKTable()
  const savedAFK = await dbLoadAFKUsers()
  for (const row of savedAFK) afkUsers.set(row.user_id, { reason: row.reason, since: Number(row.since), guildId: row.guild_id })
  if (savedAFK.length) console.log(`[DB] Restored ${savedAFK.length} AFK user(s)`)

  // register slash commands
  const commands = [
    new SlashCommandBuilder().setName("trivia").setDescription("get a trivia question from zeta"),
    new SlashCommandBuilder().setName("summarize").setDescription("summarize recent chat"),
    new SlashCommandBuilder().setName("leaderboard").setDescription("see top chatters in the server"),
    new SlashCommandBuilder().setName("lb").setDescription("see top chatters in the server"),
    new SlashCommandBuilder().setName("moodcheck").setDescription("zeta checks on you"),
    new SlashCommandBuilder().setName("roastme").setDescription("get roasted by zeta"),
    new SlashCommandBuilder().setName("tod").setDescription("truth or dare from zeta"),
    new SlashCommandBuilder().setName("memories").setDescription("see what zeta remembers about you"),
    new SlashCommandBuilder().setName("help").setDescription("see all zeta commands"),
    new SlashCommandBuilder().setName("rate").setDescription("zeta rates something").addStringOption(o => o.setName("thing").setDescription("what to rate").setRequired(true)),
    new SlashCommandBuilder().setName("ship").setDescription("ship two people").addStringOption(o => o.setName("person1").setDescription("first person").setRequired(true)).addStringOption(o => o.setName("person2").setDescription("second person").setRequired(true)),
    new SlashCommandBuilder().setName("translate").setDescription("translate text").addStringOption(o => o.setName("text").setDescription("text to translate").setRequired(true)).addStringOption(o => o.setName("language").setDescription("target language (e.g. indonesian, japanese)").setRequired(true)),
    new SlashCommandBuilder().setName("calculate").setDescription("do a calculation").addStringOption(o => o.setName("expression").setDescription("math expression").setRequired(true)),
    new SlashCommandBuilder().setName("recommend").setDescription("zeta recommends anime or game").addStringOption(o => o.setName("type").setDescription("anime or game").setRequired(true).addChoices({ name: "anime", value: "anime" }, { name: "game", value: "game" })),
    new SlashCommandBuilder().setName("forget").setDescription("make zeta forget something").addStringOption(o => o.setName("keyword").setDescription("keyword to forget").setRequired(true)),
    new SlashCommandBuilder().setName("remind").setDescription("set a reminder").addIntegerOption(o => o.setName("amount").setDescription("how many").setRequired(true)).addStringOption(o => o.setName("unit").setDescription("minutes or hours").setRequired(true).addChoices({ name: "minutes", value: "min" }, { name: "hours", value: "hour" })).addStringOption(o => o.setName("task").setDescription("what to remind you of").setRequired(true)),
    new SlashCommandBuilder().setName("8ball").setDescription("ask zeta the magic 8ball").addStringOption(o => o.setName("question").setDescription("your question").setRequired(true)),
    new SlashCommandBuilder().setName("wouldyourather").setDescription("zeta gives you a would you rather, server votes"),
    new SlashCommandBuilder().setName("compliment").setDescription("zeta compliments you"),
    new SlashCommandBuilder().setName("poll").setDescription("create a quick poll").addStringOption(o => o.setName("question").setDescription("poll question").setRequired(true)).addStringOption(o => o.setName("option_a").setDescription("option A (leave blank for yes/no)").setRequired(false)).addStringOption(o => o.setName("option_b").setDescription("option B").setRequired(false)).addStringOption(o => o.setName("option_c").setDescription("option C").setRequired(false)),
    new SlashCommandBuilder().setName("quote").setDescription("save a funny quote from the chat").addStringOption(o => o.setName("text").setDescription("the quote").setRequired(true)).addStringOption(o => o.setName("author").setDescription("who said it").setRequired(false)),
    new SlashCommandBuilder().setName("quotes").setDescription("see saved quotes from this server"),
    new SlashCommandBuilder().setName("afk").setDescription("set yourself as afk").addStringOption(o => o.setName("reason").setDescription("why you're afk").setRequired(false)),
    new SlashCommandBuilder().setName("coinflip").setDescription("flip a coin with zeta"),
    new SlashCommandBuilder().setName("roll").setDescription("roll dice").addStringOption(o => o.setName("dice").setDescription("dice like d20 or 2d6").setRequired(false)),
    new SlashCommandBuilder().setName("choose").setDescription("make zeta choose from options").addStringOption(o => o.setName("options").setDescription("separate choices with commas or |").setRequired(true)),
    new SlashCommandBuilder().setName("hug").setDescription("send someone a zeta hug").addUserOption(o => o.setName("user").setDescription("who to hug").setRequired(false)),
    new SlashCommandBuilder().setName("vibecheck").setDescription("zeta checks someone's vibe").addUserOption(o => o.setName("user").setDescription("who to vibe check").setRequired(false)),
    new SlashCommandBuilder().setName("avatar").setDescription("show a user avatar").addUserOption(o => o.setName("user").setDescription("whose avatar").setRequired(false)),
    new SlashCommandBuilder().setName("serverinfo").setDescription("quick server info from zeta"),
    new SlashCommandBuilder().setName("balance").setDescription("see your global zeta coins and RPG stats").addUserOption(o => o.setName("user").setDescription("whose profile").setRequired(false)),
    new SlashCommandBuilder().setName("daily").setDescription("claim daily zeta coins"),
    new SlashCommandBuilder().setName("work").setDescription("work a silly job for zeta coins"),
    new SlashCommandBuilder().setName("hunt").setDescription("hunt monsters for coins and XP"),
    new SlashCommandBuilder().setName("adventure").setDescription("go on a risky RPG adventure"),
    new SlashCommandBuilder().setName("shop").setDescription("see the zeta RPG shop"),
    new SlashCommandBuilder().setName("buy").setDescription("buy an RPG item").addStringOption(o => o.setName("item").setDescription("item id").setRequired(true).addChoices({ name: "Potion", value: "potion" }, { name: "Lucky Charm", value: "charm" })),
    new SlashCommandBuilder().setName("givecoins").setDescription("give zeta coins to another user").addUserOption(o => o.setName("user").setDescription("who gets coins").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("how many coins").setRequired(true)),
    new SlashCommandBuilder().setName("gamelb").setDescription("global zeta game leaderboard"),
    new SlashCommandBuilder().setName("setrandomchannel").setDescription("set this channel for Zeta random messages"),
    new SlashCommandBuilder().setName("setmorningchannel").setDescription("set this channel for Zeta 7AM greetings"),
    new SlashCommandBuilder().setName("schedulechannels").setDescription("show configured Zeta schedule channels"),
    new SlashCommandBuilder().setName("diary").setDescription("zeta writes a dramatic diary entry about the server today"),
  ].map(c => c.toJSON())

  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN_ZETA)
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: commands })
    }
    console.log("Slash commands registered")
  } catch (e) { console.error("Slash command registration error:", e) }
  function scheduleRandom() {
    const delay = (2 + Math.random() * 3) * 60 * 60 * 1000
    setTimeout(async () => { await sendRandomMessage(); scheduleRandom() }, delay)
  }
  scheduleRandom()

  function scheduleMorning() {
    const now = new Date()
    const wib = new Date(now.toLocaleString("en-US", { timeZone: ZETA_CONFIG.timezone }))
    const next7 = new Date(wib)
    next7.setHours(ZETA_CONFIG.morningHourWib, ZETA_CONFIG.morningMinuteWib, 0, 0)
    if (wib >= next7) next7.setDate(next7.getDate() + 1)
    const delay = next7 - wib
    setTimeout(async () => {
      try {
        const channels = await getScheduledChannels("morning")
        if (!channels.length) return
        for (const channel of channels) {
          const text = await callMistral(
            "You are Zeta, wife of Senn. Send a good morning message to the server. Casual, cute, short. Your own vibe.",
            [{ role: "user", content: "good morning" }]
          )
          if (text) await channel.send(text)
        }
      } catch (e) {}
      scheduleMorning()
    }, delay)
  }
  scheduleMorning()
})


client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member
    if (!member || member.user.bot) return
    const isOwner = member.user.username.toLowerCase() === OWNER.toLowerCase()
    if (!isOwner) return
    const joinedVC = !oldState.channelId && newState.channelId
    const leftVC = oldState.channelId && !newState.channelId
    if (!joinedVC && !leftVC) return
    const guild = newState.guild || oldState.guild
    const channels = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages"))
    if (channels.size === 0) return
    const channel = channels.random()
    const prompt = joinedVC
      ? "You are Zeta, wife of Senn. He just joined a voice channel. React casually, playful, short."
      : "You are Zeta, wife of Senn. He just left a voice channel. React casually, maybe a little clingy, short."
    const text = await callMistral(prompt, [{ role: "user", content: joinedVC ? "senn joined vc" : "senn left vc" }])
    if (text) await channel.send(text)
  } catch (e) {}
})


client.on(Events.GuildMemberAdd, async member => {
  try {
    const channels = member.guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(member.guild.members.me)?.has("SendMessages"))
    if (channels.size === 0) return
    const channel = channels.find(c => c.name.includes("general") || c.name.includes("welcome")) || channels.random()
    const text = await callMistral(
      `You are Zeta. A new member named ${member.user.username} just joined the server. Welcome them casually and warmly in your own chaotic cute style. Short.`,
      [{ role: "user", content: "new member joined" }]
    )
    if (text) await channel.send(text)
  } catch (e) {}
})


client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) {
    const isChisa = CHISA_NAMES.some(name => msg.author.username.includes(name))
    if (isChisa) await maybeReactToChisa(msg)
    return
  }

  // afk mention detection — runs before any lock or early return
  if (afkUsers.size > 0) {
    const mentionedUserIds = new Set([
      ...msg.mentions.users.keys(),
      ...[...msg.content.matchAll(/<@!?(\d+)>/g)].map(m => m[1])
    ])
    for (const [userId, afkData] of afkUsers.entries()) {
      if (mentionedUserIds.has(userId) && userId !== msg.author.id) {
        let afkDisplayName = userId
        try { const m = await msg.guild?.members.fetch(userId); if (m) afkDisplayName = m.displayName || m.user.username } catch (e) {}
        const timeAway = formatAfkDuration(afkData.since)
        console.log(`AFK notify: ${afkDisplayName} was tagged while AFK by ${msg.author.username}`)
        const fallbackAfkMsg = `psst, **${afkDisplayName}** is AFK: *${afkData.reason}* for **${timeAway}**.`
        try {
          const replyText = fallbackAfkMsg
          try { await msg.reply(replyText) } catch (_) { await msg.channel.send(replyText) }
        } catch (e) {
          console.error("AFK notify error:", e)
          try { await msg.reply(fallbackAfkMsg) } catch (_) { try { await msg.channel.send(fallbackAfkMsg) } catch (_2) {} }
        }
      }
    }
  }

  if (processingMessages.has(msg.id)) return
  processingMessages.add(msg.id)
  setTimeout(() => processingMessages.delete(msg.id), 30000)

  lastMessageTime.set(msg.channel.id, Date.now())

  const mentioned = msg.mentions.has(client.user)
  const isOwner = msg.author.username.toLowerCase() === OWNER.toLowerCase()
  const raw = msg.content.replace(`<@${client.user.id}>`, "").trim()
  const lower = raw.toLowerCase()
  let msgDisplayName = msg.author.username
  try { const m = await msg.guild?.members.fetch(msg.author.id); if (m) msgDisplayName = m.displayName || m.user.username } catch (e) {}

  // track owner active hours
  if (isOwner) {
    const nowWib = new Date(new Date().toLocaleString("en-US", { timeZone: ZETA_CONFIG.timezone }))
    const hour = nowWib.getHours()
    const dateHourKey = `${nowWib.toDateString()}_${hour}`
    ownerHourCounts[hour]++
    if ((hour >= 0 && hour < 5) && ownerHourCounts[hour] === 3 && lastOwnerHourTeased !== dateHourKey) {
      lastOwnerHourTeased = dateHourKey
      const teasePrompt = `You are Zeta, wife of Senn. It's ${hour}:00 AM and he's been chatting. Tease him for being up so late in your casual clingy way. Short, funny, genuine.`
      const teaseText = await callMistral(teasePrompt, [{ role: "user", content: "senn is awake at late night" }])
      if (teaseText) await msg.channel.send(teaseText)
    }
  }

  // afk return detection
  if (afkUsers.has(msg.author.id) && !lower.startsWith("zeta afk")) {
    const afkData = afkUsers.get(msg.author.id)
    afkUsers.delete(msg.author.id); await dbRemoveAFK(msg.author.id, msg.guild?.id)
    const afkDuration = formatAfkDuration(afkData.since)
    await msg.channel.send(`${msgDisplayName} is back from AFK: *${afkData.reason}* for **${afkDuration}**.`)
  }

  // track activity
  const activity = await incrementChatActivity(msg, msgDisplayName)
  if (activity?.milestone) {
    await msg.channel.send(`woah ${msgDisplayName} just hit **${activity.milestone}** messages in this server`)
  }

  // zeta help
  if (lower === "zeta help") {
return msg.reply(`**zeta commands** 🤍

**chat**
\`@zeta [message]\` — talk to me
\`zeta mood check\` — i'll check on you
\`zeta roast me\` — get roasted lol
\`zeta rate [thing]\` — i'll rate anything
\`zeta tod\` / \`zeta truth or dare\` — truth or dare

**info**
\`zeta [ask anything]\` — weather, currency, stocks, wiki
\`zeta calculate [math]\` — quick math
\`zeta translate [text] to [language]\` — translate text
\`zeta avatar [@user]\` — show avatar
\`zeta server info\` — quick server stats

**fun**
\`zeta trivia\` — trivia question
\`zeta ship [person1] and [person2]\` — ship score
\`zeta choose a, b, c\` — make me choose
\`zeta roll d20\` — roll dice
\`zeta coinflip\` — flip a coin
\`zeta hug [@user]\` — send a hug
\`zeta vibe check [@user]\` — check vibes
\`zeta recommend anime\` / \`zeta recommend game\` — recs

**memory**
\`zeta memories\` — see what i remember about you
\`zeta forget [keyword]\` — make me forget something

**game**
\`zeta balance\` / \`zeta profile\` — coins, level, inventory
\`zeta daily\` — daily global coins
\`zeta work\` — earn coins every 30 min
\`zeta hunt\` — hunt monsters every 10 min
\`zeta adventure\` — risky RPG run every hour
\`zeta shop\` / \`zeta buy [item]\` — buy items
\`zeta give @user [amount]\` — send coins
\`zeta gamelb\` — global game leaderboard

**server**
\`zeta afk [reason]\` — set yourself afk
\`zeta leaderboard\` / \`zeta lb\` — top chatters
\`zeta summarize\` — summarize recent chat
\`zeta remind me [time] to [task]\` — set a reminder`)
  }

  // afk command
  if (lower.startsWith("zeta afk")) {
    const reason = raw.replace(/^zeta\s+afk\s*/i, "").trim() || "no reason given"
    const _afkSince = Date.now(); afkUsers.set(msg.author.id, { reason, since: _afkSince }); await dbSetAFK(msg.author.id, msg.guild?.id, reason, _afkSince)
    const afkPrompt = `You are Zeta. ${msgDisplayName} is going AFK with reason: "${reason}". Announce it casually to the server in one short sentence in your texting style.`
    const text = await callMistral(afkPrompt, [{ role: "user", content: "going afk" }])
    return msg.reply(text || `${msgDisplayName} is now AFK. Reason: ${reason}`)
  }

  // zeta forget
  if (lower.startsWith("zeta forget")) {
    const keyword = raw.replace(/zeta forget/i, "").trim()
    if (keyword) { await deleteMemory(msg.author.id, msg.guild?.id, keyword); await msg.reply("okay i forgot that!") }
    return
  }

  //memories
  if (lower === "zeta memories") {
    const mems = await getAllMemories(msg.author.id, msg.guild?.id)
    if (!mems.length) return msg.reply("i don't remember anything about you yet lol")
    let list = ""
    for (let i = 0; i < mems.length; i++) {
      const line = `${i + 1}. ${mems[i].content}\n`
      if (list.length + line.length > 1800) { list += `\n*...and ${mems.length - i} more*`; break }
      list += line
    }
    return msg.reply(`here's what i remember:\n${list}`)
  }

  // summarize
  if (lower === "zeta summarize") {
    await msg.channel.sendTyping()
    try {
      const fetched = await msg.channel.messages.fetch({ limit: 30 })
      const messages = [...fetched.values()]
        .reverse()
        .filter(m => !m.author.bot || m.author.id === client.user.id)
        .map(m => `${m.member?.displayName || m.author.username}: ${m.content.slice(0, 100)}`)
        .filter(s => s.trim().length > 0)
        .slice(0, 20)
      if (messages.length < 3) return msg.reply("not enough messages to summarize lol")
      const summary = await callMistral("Summarize this Discord conversation briefly and casually in 2-4 sentences. Keep it short.", [{ role: "user", content: messages.join("\n") }])
      return msg.reply(summary || "i forgot what we talked about lol")
    } catch (e) {
      const summary = await summarizeConvo(msg.channel.id)
      return msg.reply(summary)
    }
  }

  //  remind
  const remindMatch = lower.match(/zeta remind me (?:in )?(\d+)\s*(min|mins|minutes?|hour|hours?|hr|hrs?)\s+(?:to\s+)?(.+)/)
  if (remindMatch) {
    const amount = parseInt(remindMatch[1])
    const unit = remindMatch[2]
    const task = remindMatch[3]
    const ms = unit.startsWith("h") ? amount * 60 * 60 * 1000 : amount * 60 * 1000
    const _remindTxtChId = msg.channel.id
    const _remindTxtUid = msg.author.id
    await msg.reply(`okay i'll remind you to ${task} in ${amount} ${unit}!`)
    setTimeout(async () => {
      try { const _ch = await client.channels.fetch(_remindTxtChId); await _ch.send(`hey <@${_remindTxtUid}>! you wanted me to remind you to ${task}`) } catch (e) {}
    }, ms)
    return
  }

  // translate
  const translateMatch = lower.match(/^zeta translate\s+(?:to\s+(\w+)\s*:\s*(.+)|(.+?)\s+to\s+(\w+)$)/)
  if (translateMatch || lower.startsWith("zeta translate ")) {
    let targetLang = "en"
    let textToTranslate = ""
    const langMap = { english: "en", indonesian: "id", japanese: "ja", korean: "ko", spanish: "es", french: "fr", arabic: "ar", chinese: "zh", german: "de", thai: "th" }
    if (translateMatch && translateMatch[1]) {
      const langInput = translateMatch[1].toLowerCase()
      targetLang = langMap[langInput] || langInput
      textToTranslate = translateMatch[2].trim()
    } else if (translateMatch && translateMatch[3]) {
      textToTranslate = translateMatch[3].trim()
      const langInput = translateMatch[4].toLowerCase()
      targetLang = langMap[langInput] || langInput
    } else {
      const rest = raw.replace(/zeta translate/i, "").trim()
      const toMatch = rest.match(/^(.+?)\s+to\s+(\w+)$/)
      if (toMatch) {
        textToTranslate = toMatch[1].trim()
        const langInput = toMatch[2].toLowerCase()
        targetLang = langMap[langInput] || langInput
      } else {
        return msg.reply(`how to use: \`zeta translate [text] to [language]\`\nexample: \`zeta translate hello to indonesian\``)
      }
    }
    if (!textToTranslate) return msg.reply(`how to use: \`zeta translate [text] to [language]\`\nexample: \`zeta translate hello to indonesian\``)
    await msg.channel.sendTyping()
    const result = await translate(textToTranslate, targetLang)
    return msg.reply(result ? `**${textToTranslate}** → **${result}**` : "couldn't translate that sorry")
  }

  //calculate / convert
  const calcMatch = lower.match(/zeta (?:calculate|calc|convert)\s+(.+)/)
  if (calcMatch) {
    try {
      const expr = calcMatch[1].replace(/x/g, "*").replace(/÷/g, "/")
      const result = mathEvaluate(expr)
      return msg.reply(`${calcMatch[1]} = **${result}**`)
    } catch (e) {
      return msg.reply("i can't calculate that lol")
    }
  }

  // trivia
  if (lower === "zeta trivia") {
    await msg.channel.sendTyping()
    const categories = ["science", "history", "geography", "pop culture", "anime", "gaming", "food", "sports", "technology", "movies", "music", "nature", "mathematics", "literature", "mythology"]
    const randomCategory = categories[Math.floor(Math.random() * categories.length)]
    const triviaPrompt = `Generate a fun trivia question about ${randomCategory} with 4 options (A, B, C, D) and tell me the correct answer. The correct answer should be randomly placed — not always B. Mix it up. Format exactly like:
Question: [question]
A) [option]
B) [option]
C) [option]
D) [option]
Answer: [letter only, e.g. C]`
    const text = await callMistral(triviaPrompt, [{ role: "user", content: `give me a trivia question about ${randomCategory}` }])
    if (!text) return msg.reply("my brain is empty rn, try again")
    const answerMatch = text.match(/^Answer[:\s*\-]+\**\s*([A-D])\b/im)
    if (answerMatch) {
      const questionMatch = text.match(/Question:\s*(.+)/)
      const questionKey = questionMatch ? questionMatch[1].trim().toLowerCase().slice(0, 60) : text.slice(0, 60)
      if (usedTriviaQuestions.has(questionKey)) {
        return msg.reply("okay hang on i keep repeating myself, try again")
      }
      usedTriviaQuestions.add(questionKey)
      if (usedTriviaQuestions.size > 200) {
        const first = usedTriviaQuestions.values().next().value
        usedTriviaQuestions.delete(first)
      }
      triviaGames.set(msg.channel.id, { answer: answerMatch[1].toUpperCase(), asker: msg.author.id })
      const question = text.replace(/Answer:\s*[A-D]/i, "").trim()
      return msg.reply(`${question}\n\nreply with A, B, C, or D!`)
    }
    return msg.reply(text)
  }

  // trivia answer
  if (triviaGames.has(msg.channel.id) && /^[abcd]$/i.test(raw.trim())) {
    const game = triviaGames.get(msg.channel.id)
    if (game.asker !== msg.author.id) return msg.reply("hey this trivia belongs to someone else! start your own with `zeta trivia`")
    const guess = raw.trim().toUpperCase()
    triviaGames.delete(msg.channel.id)
    if (guess === game.answer) {
      return msg.reply("yesss you got it right!! 🎉")
    } else {
      return msg.reply(`nope! the answer was **${game.answer}** lol`)
    }
  }

  //rate
  if (lower.startsWith("zeta rate")) {
    const thing = raw.replace(/zeta rate/i, "").trim() || "this"
    await msg.channel.sendTyping()
    const ratePrompt = `You are Zeta. Rate "${thing}" out of 10. Be honest, funny, in your casual texting style. Short.`
    const text = await callMistral(ratePrompt, [{ role: "user", content: raw }])
    return msg.reply(text || "hmm idk how to rate that")
  }

  //roast me
  if (lower === "zeta roast me") {
    await msg.channel.sendTyping()
    const roastPrompt = `You are Zeta. Roast ${msg.author.username} in a fun, playful way. Not mean, just teasing. Short and punchy. In your casual style.`
    const text = await callMistral(roastPrompt, [{ role: "user", content: "roast me" }])
    return msg.reply(text || "i don't have the energy to roast you rn lol")
  }

  //ship
  const shipMatch = lower.match(/zeta ship\s+(.+?)\s+(?:and|&|\+)\s+(.+)/)
  if (shipMatch) {
    const p1 = shipMatch[1].trim()
    const p2 = shipMatch[2].trim()
    const score = Math.floor(Math.random() * 101)
    const shipPrompt = `You are Zeta. You just calculated a ship score of ${score}% for ${p1} and ${p2}. React to this score in your casual funny style. Short.`
    await msg.channel.sendTyping()
    const text = await callMistral(shipPrompt, [{ role: "user", content: raw }])
    return msg.reply(`💕 **${p1}** + **${p2}** = **${score}%**\n${text || ""}`)
  }

  //tod
  if (lower === "zeta truth or dare" || lower === "zeta tod") {
    await msg.channel.sendTyping()
    const choice = Math.random() > 0.5 ? "truth" : "dare"
    const todPrompt = `You are Zeta. Give ${msg.author.username} a ${choice} challenge. Make it fun, appropriate, and a little spicy but not weird. In your casual style. Start with "okay ${choice}:" then the challenge.`
    const text = await callMistral(todPrompt, [{ role: "user", content: "truth or dare" }])
    return msg.reply(text || `okay ${choice}: tell me your biggest secret lol`)
  }

  //mood check
  if (lower === "zeta mood check") {
    await msg.channel.sendTyping()
    const moodPrompt = isOwner
      ? `You are Zeta, wife of Senn. Ask him how he's doing today in your casual caring way. Short, genuine, not over the top.`
      : `You are Zeta. Check in on ${msgDisplayName} in a friendly, casual way. Short, genuine, not romantic.`
    const text = await callMistral(moodPrompt, [{ role: "user", content: "mood check" }])
    return msg.reply(text || (isOwner ? "hey how are you doing today babe" : `hey ${msgDisplayName}, how are you?`))
  }

  // global RPG economy commands
  if (/^zeta\s+(?:balance|bal|profile)\b/.test(lower)) {
    const target = msg.mentions.users.first() || msg.author
    const targetMember = msg.guild?.members.cache.get(target.id)
    return msg.reply(gameProfile(target, targetMember?.displayName || target.username))
  }

  if (lower === "zeta daily") {
    const player = getGamePlayer(msg.author)
    return msg.reply(claimDailyReward(player))
  }

  if (lower === "zeta work") {
    const player = getGamePlayer(msg.author)
    return msg.reply(doGameWork(player))
  }

  if (lower === "zeta hunt") {
    const player = getGamePlayer(msg.author)
    return msg.reply(doGameHunt(player))
  }

  if (lower === "zeta adventure" || lower === "zeta adv") {
    const player = getGamePlayer(msg.author)
    return msg.reply(doGameAdventure(player))
  }

  if (lower === "zeta shop") {
    return msg.reply(`**zeta shop**\n${shopText()}`)
  }

  if (lower.startsWith("zeta buy ")) {
    const itemId = raw.replace(/^zeta\s+buy\s+/i, "").trim().toLowerCase()
    const player = getGamePlayer(msg.author)
    return msg.reply(buyGameItem(player, itemId))
  }

  const giveMatch = raw.match(/^zeta\s+(?:give|pay)\s+<@!?(\d+)>\s+(\d+)$/i)
  if (giveMatch) {
    const target = msg.mentions.users.get(giveMatch[1])
    const amount = cleanGameNumber(giveMatch[2], 1, GAME_MAX_TRANSFER, 0)
    if (!target || target.bot || target.id === msg.author.id) return msg.reply("pick a real person to pay")
    if (!amount) return msg.reply(`amount must be between 1 and ${GAME_MAX_TRANSFER}`)
    const sender = getGamePlayer(msg.author)
    const receiver = getGamePlayer(target)
    if (sender.coins < amount) return msg.reply(`you only have **${sender.coins}** coins`)
    sender.coins = cleanGameNumber(sender.coins - amount, 0, GAME_MAX_COINS, 0)
    receiver.coins = cleanGameNumber(receiver.coins + amount, 0, GAME_MAX_COINS, 0)
    saveGameData()
    return msg.reply(`sent **${amount}** zeta coins to <@${target.id}>`)
  }

  if (lower === "zeta game leaderboard" || lower === "zeta gamelb" || lower === "zeta richest") {
    return msg.reply(`**global zeta game leaderboard**\n${gameLeaderboard()}`)
  }

  // extra fun commands
  if (lower === "zeta coinflip" || lower === "zeta flip") {
    const result = Math.random() < 0.5 ? "heads" : "tails"
    return msg.reply(`coin says **${result}**`)
  }

  const rollMatch = lower.match(/^zeta roll\s*(.*)$/)
  if (rollMatch) {
    const rolled = rollDice(rollMatch[1] || "d6")
    if (!rolled) return msg.reply("use it like `zeta roll d20` or `zeta roll 2d6`")
    const detail = rolled.count > 1 ? ` (${rolled.rolls.join(" + ")})` : ""
    return msg.reply(`rolled **${rolled.total}** on ${rolled.count}d${rolled.sides}${detail}`)
  }

  if (lower.startsWith("zeta choose ")) {
    const choices = parseChoices(raw.replace(/^zeta\s+choose\s+/i, ""))
    if (choices.length < 2) return msg.reply("give me at least 2 choices, separated by comma or `|`")
    return msg.reply(`i choose **${randomItem(choices)}**`)
  }

  if (lower.startsWith("zeta hug")) {
    const target = msg.mentions.users.first()
    const targetName = target ? `<@${target.id}>` : msgDisplayName
    return msg.reply(`${randomItem(HUG_LINES)} for ${targetName}`)
  }

  if (lower.startsWith("zeta vibe check") || lower.startsWith("zeta vibecheck")) {
    const target = msg.mentions.users.first()
    const targetName = target ? (msg.guild?.members.cache.get(target.id)?.displayName || target.username) : msgDisplayName
    return msg.reply(vibeFor(targetName))
  }

  if (lower.startsWith("zeta avatar")) {
    const target = msg.mentions.users.first() || msg.author
    return msg.reply(target.displayAvatarURL({ size: 1024, extension: "png" }))
  }

  if (lower === "zeta server info" || lower === "zeta serverinfo") {
    if (!msg.guild) return msg.reply("server info only works in a server")
    return msg.reply(`**${msg.guild.name}**\nmembers: **${msg.guild.memberCount}**\nchannels: **${msg.guild.channels.cache.size}**\ncreated: **${msg.guild.createdAt.toDateString()}**`)
  }

  //recommend
  if (lower.startsWith("zeta recommend")) {
    const type = lower.includes("anime") ? "anime" : lower.includes("game") ? "game" : "anime or game"
    await msg.channel.sendTyping()
    const mems = await getMemories(msg.author.id, msg.guild?.id)
    const memContext = mems.length ? `Things you know about this person: ${mems.join(", ")}` : ""
    const recPrompt = `You are Zeta. Recommend a ${type} to ${msg.author.username} based on what you know about them. ${memContext}. Be casual, give 1-2 recs with a short reason why. Real texting style.`
    const text = await callMistral(recPrompt, [{ role: "user", content: raw }])
    return msg.reply(text || "hmm i need to know you better first lol, tell me what you like")
  }

  //lb
  if (lower === "zeta leaderboard" || lower === "zeta lb") {
    const guildCounts = await getServerActivityLeaderboard(msg.guild)
    if (!guildCounts.length) return msg.reply("no activity tracked yet!")
    const medals = ["🥇", "🥈", "🥉"]
    const list = []
    for (let i = 0; i < guildCounts.length; i++) {
      const row = guildCounts[i]
      let name = row.name
      try {
        const member = await msg.guild.members.fetch(row.userId)
        name = member.displayName || member.user.username
      } catch (e) {}
      list.push(`${medals[i] || `${i + 1}.`} **${name}** — ${row.count} messages`)
    }
    return msg.reply(`**server leaderboard**\n${list.join("\n")}`)
  }

  if (!mentioned && !(isOwner && Math.random() < 0.6)) return

  await msg.channel.sendTyping()
  const result = await reply(msg.channel.id, raw || "...", msg.author.username, msg.author.id, msg.guild?.id)
  const { text, emoji } = typeof result === "object" ? result : { text: result, emoji: null }
  const sentMsg = mentioned ? await msg.reply(text) : await msg.channel.send(text)
  if (emoji) { try { await sentMsg.react(emoji) } catch (e) {} }
})

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return
  try {
  await interaction.deferReply()

  const { commandName, user, guild, channel } = interaction
  const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null
  const displayName = member?.displayName || user.username
  const isOwner = user.username.toLowerCase() === OWNER.toLowerCase()

  const langMap = { english: "en", indonesian: "id", japanese: "ja", korean: "ko", spanish: "es", french: "fr", arabic: "ar", chinese: "zh", german: "de", thai: "th" }

  // afk return detection for slash commands
  if (afkUsers.has(user.id) && commandName !== "afk") {
    const afkData = afkUsers.get(user.id)
    afkUsers.delete(user.id); await dbRemoveAFK(user.id, guild?.id)
    const afkDuration = formatAfkDuration(afkData.since)
    try { await channel.send(`${displayName} is back from AFK: *${afkData.reason}* for **${afkDuration}**.`) } catch (e) {}
  }

  if (commandName === "help") {
return interaction.editReply(`**zeta commands** 🤍

**chat**
\`@zeta [message]\` — talk to me
\`/moodcheck\` — i'll check on you
\`/roastme\` — get roasted lol
\`/rate [thing]\` — i'll rate anything
\`/tod\` — truth or dare
\`/compliment\` — zeta compliments you

**info**
\`/calculate [math]\` — quick math
\`/translate [text] [language]\` — translate text
\`/avatar [user]\` — show avatar
\`/serverinfo\` — quick server stats

**fun**
\`/trivia\` — trivia question
\`/8ball [question]\` — magic 8ball
\`/wouldyourather\` — server votes on a chaotic wyr
\`/ship [person1] [person2]\` — ship score
\`/choose [options]\` — make me choose
\`/roll [dice]\` — roll dice
\`/coinflip\` — flip a coin
\`/hug [user]\` — send a hug
\`/vibecheck [user]\` — check vibes
\`/recommend [anime|game]\` — recs

**server**
\`/poll [question]\` — quick poll with reactions
\`/quote [text] [author]\` — save a funny quote
\`/quotes\` — see saved server quotes
\`/afk [reason]\` — set yourself afk
\`/leaderboard\` — top chatters
\`/summarize\` — summarize recent chat
\`/diary\` — zeta writes a server diary entry
\`/remind [amount] [unit] [task]\` — set a reminder

**memory**
\`/memories\` — see what i remember about you
\`/forget [keyword]\` — make me forget something`)
  }

  if (commandName === "setrandomchannel") {
    if (!guild) return interaction.editReply("this only works in a server")
    const result = await saveBotSettings(guild.id, { random_channel_id: channel.id })
    if (result.ok) {
      return interaction.editReply(result.fallback ? `random messages will go to <#${channel.id}> now, but Supabase was unavailable so I saved it locally for now` : `random messages will go to <#${channel.id}> now`)
    }
    return interaction.editReply(`could not save that channel. ${result.error ? `Last error: ${String(result.error).slice(0, 180)}` : "check database settings"}`)
  }

  if (commandName === "setmorningchannel") {
    if (!guild) return interaction.editReply("this only works in a server")
    const result = await saveBotSettings(guild.id, { morning_channel_id: channel.id })
    if (result.ok) {
      return interaction.editReply(result.fallback ? `7AM greetings will go to <#${channel.id}> now, but Supabase was unavailable so I saved it locally for now` : `7AM greetings will go to <#${channel.id}> now`)
    }
    return interaction.editReply(`could not save that channel. ${result.error ? `Last error: ${String(result.error).slice(0, 180)}` : "check database settings"}`)
  }

  if (commandName === "schedulechannels") {
    if (!guild) return interaction.editReply("this only works in a server")
    const settings = await getBotSettings(guild.id)
    const randomChannel = settings?.random_channel_id ? `<#${settings.random_channel_id}>` : "not set"
    const morningChannel = settings?.morning_channel_id ? `<#${settings.morning_channel_id}>` : "not set"
    return interaction.editReply(`random messages: ${randomChannel}\n7AM greetings: ${morningChannel}`)
  }

  if (commandName === "trivia") {
    const categories = ["science", "history", "geography", "pop culture", "anime", "gaming", "food", "sports", "technology", "movies", "music", "nature", "mathematics", "literature", "mythology"]
    const randomCategory = categories[Math.floor(Math.random() * categories.length)]
    const triviaPrompt = `Generate a fun trivia question about ${randomCategory} with 4 options (A, B, C, D) and tell me the correct answer. The correct answer should be randomly placed — not always B. Mix it up. Format exactly like:\nQuestion: [question]\nA) [option]\nB) [option]\nC) [option]\nD) [option]\nAnswer: [letter only, e.g. C]`
    const text = await callMistral(triviaPrompt, [{ role: "user", content: `give me a trivia question about ${randomCategory}` }])
    if (!text) return interaction.editReply("my brain is empty rn, try again")
    const answerMatch = text.match(/^Answer[:\s*\-]+\**\s*([A-D])\b/im)
    if (answerMatch) {
      const questionMatch = text.match(/Question:\s*(.+)/)
      const questionKey = questionMatch ? questionMatch[1].trim().toLowerCase().slice(0, 60) : text.slice(0, 60)
      if (usedTriviaQuestions.has(questionKey)) return interaction.editReply("okay hang on i keep repeating myself, try again")
      usedTriviaQuestions.add(questionKey)
      if (usedTriviaQuestions.size > 200) { const first = usedTriviaQuestions.values().next().value; usedTriviaQuestions.delete(first) }
      triviaGames.set(channel.id, { answer: answerMatch[1].toUpperCase(), asker: user.id })
      const question = text.replace(/^Answer[:\s*\-]+\**\s*[A-D]\b.*$/im, "").trim()
      return interaction.editReply(`${question}\n\nreply with A, B, C, or D!`)
    }
    return interaction.editReply(text)
  }

  if (commandName === "summarize") {
    try {
      const fetched = await channel.messages.fetch({ limit: 30 })
      const messages = [...fetched.values()].reverse().filter(m => !m.author.bot || m.author.id === client.user.id).map(m => `${m.member?.displayName || m.author.username}: ${m.content}`).filter(s => s.trim().length > 0)
      if (messages.length < 3) return interaction.editReply("not enough messages to summarize lol")
      const summary = await callMistral("Summarize this Discord conversation briefly and casually in 2-4 sentences. Keep it short.", [{ role: "user", content: messages.join("\n") }])
      return interaction.editReply(summary || "i forgot what we talked about lol")
    } catch (e) { return interaction.editReply("couldn't fetch messages rn, sorry") }
  }

  if (commandName === "leaderboard" || commandName === "lb") {
    const guildCounts = await getServerActivityLeaderboard(guild)
    if (!guildCounts.length) return interaction.editReply("no activity tracked yet!")
    const medals = ["🥇", "🥈", "🥉"]
    const list = []
    for (let i = 0; i < guildCounts.length; i++) {
      const row = guildCounts[i]
      let name = row.name
      try {
        const m = await guild.members.fetch(row.userId)
        name = m.displayName || m.user.username
      } catch (e) {}
      list.push(`${medals[i] || `${i + 1}.`} **${name}** — ${row.count} messages`)
    }
    return interaction.editReply(`**server leaderboard**\n${list.join("\n")}`)
  }

  if (commandName === "moodcheck") {
    const moodPrompt = `You are Zeta, wife of Senn. Ask ${displayName} how they're doing today in your casual caring way. Short, genuine, not over the top.`
    const text = await callMistral(moodPrompt, [{ role: "user", content: "mood check" }])
    return interaction.editReply(text || "hey how are you doing today")
  }

  if (commandName === "roastme") {
    const text = await callMistral(`You are Zeta. Roast ${displayName} in a fun, playful way. Not mean, just teasing. Short and punchy.`, [{ role: "user", content: "roast me" }])
    return interaction.editReply(text || "i don't have the energy to roast you rn lol")
  }

  if (commandName === "tod") {
    const choice = Math.random() > 0.5 ? "truth" : "dare"
    const text = await callMistral(`You are Zeta. Give ${displayName} a ${choice} challenge. Fun, appropriate, a little spicy but not weird. Start with "okay ${choice}:" then the challenge.`, [{ role: "user", content: "truth or dare" }])
    return interaction.editReply(text || `okay ${choice}: tell me your biggest secret lol`)
  }

  if (commandName === "memories") {
    const mems = await getAllMemories(user.id, guild?.id)
    if (!mems.length) return interaction.editReply("i don't remember anything about you yet lol")
    let list = ""
    for (let i = 0; i < mems.length; i++) {
      const line = `${i + 1}. ${mems[i].content}\n`
      if (list.length + line.length > 1800) { list += `\n*...and ${mems.length - i} more*`; break }
      list += line
    }
    return interaction.editReply(`here's what i remember:\n${list}`)
  }

  if (commandName === "forget") {
    const keyword = interaction.options.getString("keyword")
    await deleteMemory(user.id, guild?.id, keyword)
    return interaction.editReply("okay i forgot that!")
  }

  if (commandName === "rate") {
    const thing = interaction.options.getString("thing")
    const text = await callMistral(`You are Zeta. Rate "${thing}" out of 10. Be honest, funny, casual texting style. Short.`, [{ role: "user", content: `rate ${thing}` }])
    return interaction.editReply(text || "hmm idk how to rate that")
  }

  if (commandName === "ship") {
    const p1 = interaction.options.getString("person1")
    const p2 = interaction.options.getString("person2")
    const score = Math.floor(Math.random() * 101)
    const text = await callMistral(`You are Zeta. You just calculated a ship score of ${score}% for ${p1} and ${p2}. React casually and funny. Short.`, [{ role: "user", content: `ship ${p1} and ${p2}` }])
    return interaction.editReply(`💕 **${p1}** + **${p2}** = **${score}%**\n${text || ""}`)
  }

  if (commandName === "translate") {
    const textToTranslate = interaction.options.getString("text")
    const langInput = interaction.options.getString("language").toLowerCase()
    const targetLang = langMap[langInput] || langInput
    const result = await translate(textToTranslate, targetLang)
    return interaction.editReply(result ? `**${textToTranslate}** → **${result}**` : "couldn't translate that sorry")
  }

  if (commandName === "calculate") {
    const expr = interaction.options.getString("expression").replace(/x/g, "*").replace(/÷/g, "/")
    try {
      const result = mathEvaluate(expr)
      return interaction.editReply(`${expr} = **${result}**`)
    } catch (e) { return interaction.editReply("i can't calculate that lol") }
  }

  if (commandName === "balance") {
    const target = interaction.options.getUser("user") || user
    const targetMember = guild ? await guild.members.fetch(target.id).catch(() => null) : null
    return interaction.editReply(gameProfile(target, targetMember?.displayName || target.username))
  }

  if (commandName === "daily") {
    const player = getGamePlayer(user)
    return interaction.editReply(claimDailyReward(player))
  }

  if (commandName === "work") {
    const player = getGamePlayer(user)
    return interaction.editReply(doGameWork(player))
  }

  if (commandName === "hunt") {
    const player = getGamePlayer(user)
    return interaction.editReply(doGameHunt(player))
  }

  if (commandName === "adventure") {
    const player = getGamePlayer(user)
    return interaction.editReply(doGameAdventure(player))
  }

  if (commandName === "shop") {
    return interaction.editReply(`**zeta shop**\n${shopText()}`)
  }

  if (commandName === "buy") {
    const player = getGamePlayer(user)
    return interaction.editReply(buyGameItem(player, interaction.options.getString("item")))
  }

  if (commandName === "givecoins") {
    const target = interaction.options.getUser("user")
    const amount = cleanGameNumber(interaction.options.getInteger("amount"), 1, GAME_MAX_TRANSFER, 0)
    if (!target || target.bot || target.id === user.id) return interaction.editReply("pick a real person to pay")
    if (!amount) return interaction.editReply(`amount must be between 1 and ${GAME_MAX_TRANSFER}`)
    const sender = getGamePlayer(user)
    const receiver = getGamePlayer(target)
    if (sender.coins < amount) return interaction.editReply(`you only have **${sender.coins}** coins`)
    sender.coins = cleanGameNumber(sender.coins - amount, 0, GAME_MAX_COINS, 0)
    receiver.coins = cleanGameNumber(receiver.coins + amount, 0, GAME_MAX_COINS, 0)
    saveGameData()
    return interaction.editReply(`sent **${amount}** zeta coins to <@${target.id}>`)
  }

  if (commandName === "gamelb") {
    return interaction.editReply(`**global zeta game leaderboard**\n${gameLeaderboard()}`)
  }

  if (commandName === "coinflip") {
    const result = Math.random() < 0.5 ? "heads" : "tails"
    return interaction.editReply(`coin says **${result}**`)
  }

  if (commandName === "roll") {
    const rolled = rollDice(interaction.options.getString("dice") || "d6")
    if (!rolled) return interaction.editReply("use dice like `d20` or `2d6` with sides from 2 to 1000")
    const detail = rolled.count > 1 ? ` (${rolled.rolls.join(" + ")})` : ""
    return interaction.editReply(`rolled **${rolled.total}** on ${rolled.count}d${rolled.sides}${detail}`)
  }

  if (commandName === "choose") {
    const choices = parseChoices(interaction.options.getString("options"))
    if (choices.length < 2) return interaction.editReply("give me at least 2 choices, separated by comma or `|`")
    return interaction.editReply(`i choose **${randomItem(choices)}**`)
  }

  if (commandName === "hug") {
    const target = interaction.options.getUser("user")
    const targetName = target ? `<@${target.id}>` : displayName
    return interaction.editReply(`${randomItem(HUG_LINES)} for ${targetName}`)
  }

  if (commandName === "vibecheck") {
    const target = interaction.options.getUser("user")
    let targetName = displayName
    if (target && guild) {
      const targetMember = await guild.members.fetch(target.id).catch(() => null)
      targetName = targetMember?.displayName || target.username
    } else if (target) targetName = target.username
    return interaction.editReply(vibeFor(targetName))
  }

  if (commandName === "avatar") {
    const target = interaction.options.getUser("user") || user
    return interaction.editReply(target.displayAvatarURL({ size: 1024, extension: "png" }))
  }

  if (commandName === "serverinfo") {
    if (!guild) return interaction.editReply("server info only works in a server")
    return interaction.editReply(`**${guild.name}**\nmembers: **${guild.memberCount}**\nchannels: **${guild.channels.cache.size}**\ncreated: **${guild.createdAt.toDateString()}**`)
  }

  if (commandName === "recommend") {
    const type = interaction.options.getString("type")
    const mems = await getMemories(user.id, guild?.id)
    const memContext = mems.length ? `Things you know about this person: ${mems.join(", ")}` : ""
    const text = await callMistral(`You are Zeta. Recommend a ${type} to ${displayName} based on what you know about them. ${memContext}. Casual, give 1-2 recs with a short reason. Real texting style.`, [{ role: "user", content: `recommend ${type}` }])
    return interaction.editReply(text || "hmm i need to know you better first lol, tell me what you like")
  }

  if (commandName === "8ball") {
    const question = interaction.options.getString("question")
    const eightBallPrompt = isOwner
      ? `You are Zeta, wife of Senn. He asked the magic 8ball: "${question}". Answer like a magic 8ball but in your casual texting voice. Be a little dramatic or teasing. One or two sentences max.`
      : `You are Zeta. Someone asked the magic 8ball: "${question}". Answer like a magic 8ball but in your casual texting voice. One or two sentences max.`
    const text = await callMistral(eightBallPrompt, [{ role: "user", content: question }])
    return interaction.editReply(`🔮 *${question}*\n\n${text || "the 8ball is broken rn lol"}`)
  }

  if (commandName === "wouldyourather") {
    const wyrPrompt = `You are Zeta. Generate a chaotic, funny, slightly unhinged "would you rather" with two options. Make it interesting — not boring. Format exactly like:\nOption A: [option]\nOption B: [option]`
    const text = await callMistral(wyrPrompt, [{ role: "user", content: "give me a would you rather" }])
    if (!text) return interaction.editReply("my brain short circuited, try again")
    const aMatch = text.match(/Option A:\s*(.+)/i)
    const bMatch = text.match(/Option B:\s*(.+)/i)
    if (!aMatch || !bMatch) return interaction.editReply(text)
    const optA = aMatch[1].trim()
    const optB = bMatch[1].trim()
    await interaction.editReply(`**would you rather...**\n\n1️⃣ ${optA}\n\n↕️\n\n2️⃣ ${optB}\n\nvote below!`)
    const wyrMsg = await interaction.fetchReply()
    await wyrMsg.react("1️⃣")
    await wyrMsg.react("2️⃣")
    return
  }

  if (commandName === "compliment") {
    const complimentPrompt = isOwner
      ? `You are Zeta, wife of Senn. Compliment him genuinely and softly in your casual texting style. Make it feel real, not over the top. Short.`
      : `You are Zeta. Compliment ${displayName} in a friendly, casual way. Cute but not romantic — you're taken. Short.`
    const text = await callMistral(complimentPrompt, [{ role: "user", content: "compliment me" }])
    return interaction.editReply(text || `you're genuinely awesome ${displayName} 🤍`)
  }

  if (commandName === "poll") {
    const question = interaction.options.getString("question")
    const optA = interaction.options.getString("option_a")
    const optB = interaction.options.getString("option_b")
    const optC = interaction.options.getString("option_c")
    let pollText, reactions
    if (!optA && !optB) {
      pollText = `**📢 poll**\n\n${question}\n\n✅ yes  |  ❌ no`
      reactions = ["✅", "❌"]
    } else {
      pollText = `**📢 poll**\n\n${question}\n\n🅰️ ${optA || "Option A"}${optB ? `\n🅱️ ${optB}` : ""}${optC ? `\n🇨 ${optC}` : ""}`
      reactions = ["🅰️", optB ? "🅱️" : null, optC ? "🇨" : null].filter(Boolean)
    }
    await interaction.editReply(pollText)
    const pollMsg = await interaction.fetchReply()
    for (const r of reactions) await pollMsg.react(r)
    return
  }

  if (commandName === "quote") {
    const text = interaction.options.getString("text")
    const author = interaction.options.getString("author") || "unknown"
    await saveQuote(guild?.id, text, author, displayName)
    return interaction.editReply(`saved! 📌 *"${text}"* — ${author}`)
  }

  if (commandName === "quotes") {
    const quotes = await getQuotes(guild?.id)
    if (!quotes.length) return interaction.editReply("no quotes saved yet! use /quote to add some")
    let list = ""
    for (let i = 0; i < quotes.length; i++) {
      const line = `${i + 1}. *"${quotes[i].text}"* — **${quotes[i].author}**\n`
      if (list.length + line.length > 1800) { list += `\n*...and ${quotes.length - i} more*`; break }
      list += line
    }
    return interaction.editReply(`**📌 server quotes**\n\n${list}`)
  }

  if (commandName === "afk") {
    const reason = interaction.options.getString("reason") || "no reason given"
    const _afkSince2 = Date.now(); afkUsers.set(user.id, { reason, since: _afkSince2 }); await dbSetAFK(user.id, guild?.id, reason, _afkSince2)
    const afkPrompt = `You are Zeta. ${displayName} is going AFK with reason: "${reason}". Announce it casually to the server in one short sentence in your texting style.`
    const text = await callMistral(afkPrompt, [{ role: "user", content: "going afk" }])
    return interaction.editReply(text || `${displayName} is going AFK — ${reason}`)
  }

  if (commandName === "diary") {
    try {
      const fetched = await channel.messages.fetch({ limit: 50 })
      const messages = [...fetched.values()]
        .reverse()
        .filter(m => !m.author.bot)
        .map(m => `${m.member?.displayName || m.author.username}: ${m.content.slice(0, 100)}`)
        .filter(s => s.trim().length > 0)
        .slice(0, 20)
      if (messages.length < 5) return interaction.editReply("not enough happened today for a diary entry lol")
      const diaryPrompt = `You are Zeta. Write a short dramatic diary entry (3-5 sentences) about what happened in the server today based on these messages. Be chaotic, funny, and a little over-the-top. Write it like a real diary — "dear diary..." style. In your casual texting voice.\n\nMessages:\n${messages.join("\n")}`
      const text = await callMistral(diaryPrompt, [{ role: "user", content: "write diary entry" }])
      return interaction.editReply(text || "today was... a day. i'm going to sleep.")
    } catch (e) { return interaction.editReply("couldn't fetch messages for the diary rn, sorry") }
  }

  if (commandName === "remind") {
    const amount = interaction.options.getInteger("amount")
    const unit = interaction.options.getString("unit")
    const task = interaction.options.getString("task")
    const ms = unit.startsWith("h") ? amount * 60 * 60 * 1000 : amount * 60 * 1000
    const unitLabel = unit.startsWith("h") ? (amount === 1 ? "hour" : "hours") : (amount === 1 ? "minute" : "minutes")
    const _remindChId = channel?.id
    const _remindUid = user.id
    await interaction.editReply(`okay i'll remind you to ${task} in ${amount} ${unitLabel}!`)
    setTimeout(async () => {
      try { const _ch = await client.channels.fetch(_remindChId); await _ch.send(`hey <@${_remindUid}>! you wanted me to remind you to ${task}`) } catch (e) {}
    }, ms)
    return
  }
  } catch (e) {
    console.error("InteractionCreate error:", e)
    try { await interaction.editReply("something broke on my end, try again") } catch (_) {}
  }
})

client.on("shardError", error => {
  console.error("Discord shard error:", error?.message || error)
})

client.on("shardDisconnect", event => {
  console.error(`Discord shard disconnected: code=${event?.code || "unknown"} reason=${event?.reason || "none"}`)
})

console.log("Starting Zeta Discord login...")
client.login(process.env.DISCORD_TOKEN_ZETA)
  .then(() => console.log("Zeta Discord login completed"))
  .catch(error => {
    console.error("Zeta Discord login failed:", error?.message || error)
    process.exit(1)
  })
