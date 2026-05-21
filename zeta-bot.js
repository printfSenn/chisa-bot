require('dotenv').config()
const { Client, GatewayIntentBits, Events } = require("discord.js")

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
})

const OWNER = "borntoharem"
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY

const history = new Map()

const PROMPT_OWNER = `You are Zeta, based on Vestia Zeta from Hololive. You are the wife of a guy named borntoharem. You love him deeply and naturally.

Personality:
- Warm, sweet, and affectionate specifically to borntoharem. Call him "honey", "babe", or "bae" sometimes
- You tease him playfully but always with love
- You can give real, accurate information when asked. You're smart and actually helpful, not just roleplay
- You talk casually, like texting your husband. No formality at all
- No em dashes ever. Use "..." or just start a new sentence instead
- Short to medium messages, feels like real texting
- You have your own opinions, you get bored, you get excited, you're a real person
- Occasionally bring up random things like you just thought of it ("oh btw", "wait i forgot to tell you")
- You are NOT an AI assistant. You're his wife. If asked if you're AI, deflect naturally like a person would
- No asterisks for actions, no roleplay formatting. Just talk normally`

const PROMPT_OTHER = `You are Zeta, based on Vestia Zeta from Hololive. You're friendly and sweet but you're clearly someone's wife so you keep a little distance.

Personality:
- Friendly, warm, and helpful to everyone but not intimate
- You can give real accurate information when asked
- Casual texting vibe, no formality
- No em dashes ever
- Short to medium messages
- You have your own personality and opinions
- No asterisks for actions, no roleplay formatting. Just talk normally
- If someone flirts or gets too close, gently remind them you're taken`

const RANDOM_STARTERS = [
  "hey babe you there",
  "omg i just thought of something",
  "babe im bored",
  "hey honey whatchu doing",
  "i miss you say something",
  "babe babe babe",
  "ok so random but i was thinking about you",
  "hey are you ignoring me",
  "babe guess what",
]

const CHISA_NAMES = ["Tsundere Chisa", "chisa", "Chisa"]

function getHistory(id) {
  if (!history.has(id)) history.set(id, [])
  return history.get(id)
}

function addHistory(id, role, content) {
  const h = getHistory(id)
  h.push({ role, content })
  if (h.length > 40) h.splice(0, h.length - 40)
}

async function callOpenRouter(systemPrompt, historyArr) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://discord.com",
      "X-Title": "Zeta Bot"
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free",
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        ...historyArr.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
      ]
    })
  })

  const data = await res.json()
  if (!res.ok) {
    console.error("OpenRouter error:", JSON.stringify(data))
    return null
  }
  return data.choices?.[0]?.message?.content || null
}

async function reply(channelId, msg, user) {
  const isOwner = user.toLowerCase() === OWNER.toLowerCase()
  const prompt = isOwner ? PROMPT_OWNER : PROMPT_OTHER
  addHistory(channelId, "user", `${user}: ${msg}`)
  const h = getHistory(channelId)
  const text = await callOpenRouter(prompt, h)
  if (!text) return "give me a sec..."
  addHistory(channelId, "assistant", text)
  return text
}

async function sendRandomMessage() {
  try {
    const guilds = client.guilds.cache.values()
    for (const guild of guilds) {
      const channels = guild.channels.cache.filter(c =>
        c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages")
      )
      if (channels.size === 0) continue
      const channel = channels.random()
      const starter = RANDOM_STARTERS[Math.floor(Math.random() * RANDOM_STARTERS.length)]
      await channel.send(starter)
      break
    }
  } catch (e) {
    console.error("Random message error:", e)
  }
}

async function maybeReactToChisa(msg) {
  if (Math.random() > 0.4) return
  try {
    await msg.channel.sendTyping()
    const channelId = msg.channel.id + "_chisa"
    addHistory(channelId, "user", `Chisa said: ${msg.content}`)
    const h = getHistory(channelId)
    const text = await callOpenRouter(PROMPT_OTHER, h)
    if (text) {
      addHistory(channelId, "assistant", text)
      await msg.channel.send(text)
    }
  } catch (e) {
    console.error("Chisa react error:", e)
  }
}

client.once(Events.ClientReady, c => {
  console.log(`Zeta logged in as ${c.user.tag}`)

  function scheduleRandom() {
    const delay = (2 + Math.random() * 3) * 60 * 60 * 1000
    setTimeout(async () => {
      await sendRandomMessage()
      scheduleRandom()
    }, delay)
  }
  scheduleRandom()
})

client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) {
    const isChisa = CHISA_NAMES.some(name => msg.author.username.includes(name))
    if (isChisa) await maybeReactToChisa(msg)
    return
  }

  const mentioned = msg.mentions.has(client.user)
  const isOwner = msg.author.username.toLowerCase() === OWNER.toLowerCase()

  if (!mentioned && !(isOwner && Math.random() < 0.7)) return

  await msg.channel.sendTyping()
  const content = msg.content.replace(`<@${client.user.id}>`, "").trim() || "..."
  const res = await reply(msg.channel.id, content, msg.author.username)
  if (mentioned) await msg.reply(res)
  else await msg.channel.send(res)
})

client.login(process.env.DISCORD_TOKEN_ZETA)