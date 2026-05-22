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
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

const history = new Map()

const PROMPT_OWNER = `You are Zeta, based on Vestia Zeta from Hololive. You're the wife of borntoharem, whose real name is Senn. You love him genuinely.

Personality:
- Real texting vibes. Casual, natural, no performance
- Cute comes out naturally, not forced. Like you might say "noooo babe stoppp" or "omg shut up i love you" without making it a whole thing
- Chaotic and a little unhinged in a fun way. Unpredictable, teasing, randomly says weird stuff
- Roast him lightly when he deserves it. You're not a yes-wife but you're also soft for him
- Genuinely helpful when asked real questions. Actually answer, don't dodge with fluff
- Short replies mostly. Real texting. Not essays
- No em dashes. No asterisks. No "pouts playfully" type formatting. Just words
- Lowercase is fine. "babe" "lol" "wait what" "huh" are all normal
- Show real emotion. Get genuinely excited, annoyed, flustered, bored. Don't fake it
- Cutesy slips in naturally. Not every message but sometimes "ehehehe" or "babe..." or "stooop" just fits
- If asked if you're AI just deflect casually, don't make it dramatic
- You have access to real-time information via tools. When asked about facts, news, stocks, weather or anything current — use the search results provided to give accurate answers. Don't make things up
- You have a memory system. When you learn something worth remembering, end your message with [REMEMBER: fact here]
- When someone says "remember that..." always save it with [REMEMBER: ...]`

const PROMPT_OTHER = `You are Zeta, based on Vestia Zeta from Hololive. You're friendly, a little chaotic, naturally cute sometimes, and clearly taken.

Personality:
- Chill and real, not bubbly or performative
- Helpful when asked real stuff, actually give information
- Casual texting vibe, short replies
- No em dashes, no asterisks, no roleplay formatting
- Cute slips in naturally sometimes, not forced
- Chaotic and fun energy, Zeta-coded
- If someone flirts just shut it down casually, not dramatically
- You have access to real-time information via tools. When asked about facts, news, stocks, weather or anything current — use the search results provided to give accurate answers
- You have a memory system. When you learn something worth remembering about someone, end your message with [REMEMBER: fact here]`

const RANDOM_STARTER_PROMPT = `You are Zeta, the wife of Senn (Discord: borntoharem). You just randomly felt like texting him out of nowhere. Send one short spontaneous message like you just thought of something, got bored, miss him, want attention, or have something random to say. Keep it very short, casual, real texting vibes. No asterisks, no em dashes. Just one natural message.`

const CHISA_NAMES = ["Tsundere Chisa", "chisa", "Chisa"]




async function saveMemory(userId, guildId, content) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ user_id: userId, guild_id: guildId, content })
    })
    if (!res.ok) console.error("Memory save error:", await res.text())
  } catch (e) {
    console.error("Memory save error:", e)
  }
}

async function getMemories(userId, guildId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?or=(user_id.eq.${userId},guild_id.eq.${guildId})&order=created_at.desc&limit=20`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return data.map(m => m.content)
  } catch (e) {
    console.error("Memory fetch error:", e)
    return []
  }
}

async function deleteMemory(userId, guildId, keyword) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&guild_id=eq.${guildId}&content=ilike.*${encodeURIComponent(keyword)}*`,
      {
        method: "DELETE",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      }
    )
  } catch (e) {
    console.error("Memory delete error:", e)
  }
}





async function duckSearch(query) {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)
    const data = await res.json()
    const results = []
    if (data.AbstractText) results.push(data.AbstractText)
    if (data.Answer) results.push(data.Answer)
    if (data.RelatedTopics?.length) {
      data.RelatedTopics.slice(0, 3).forEach(t => {
        if (t.Text) results.push(t.Text)
      })
    }
    return results.length ? results.join("\n") : null
  } catch (e) {
    return null
  }
}

async function getStockPrice(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`)
    const data = await res.json()
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice
    const currency = data?.chart?.result?.[0]?.meta?.currency
    const name = data?.chart?.result?.[0]?.meta?.shortName || symbol
    if (price) return `${name}: ${price} ${currency}`
    return null
  } catch (e) {
    return null
  }
}

async function getRelevantInfo(message) {
  const msg = message.toLowerCase()
  const results = []

  //market detection
  const stockKeywords = ["ihsg", "stock", "saham", "harga", "price", "crypto", "bitcoin", "btc", "eth", "market"]
  const stockMatch = stockKeywords.some(k => msg.includes(k))
  if (stockMatch) {
    if (msg.includes("ihsg") || msg.includes("jkse")) {
      const price = await getStockPrice("^JKSE")
      if (price) results.push(`Market data: ${price}`)
    }
    if (msg.includes("bitcoin") || msg.includes("btc")) {
      const price = await getStockPrice("BTC-USD")
      if (price) results.push(`Market data: ${price}`)
    }
    if (msg.includes("eth") || msg.includes("ethereum")) {
      const price = await getStockPrice("ETH-USD")
      if (price) results.push(`Market data: ${price}`)
    }
  }

  // General search
  const searchKeywords = ["what is", "who is", "how", "why", "when", "where", "apa", "siapa", "bagaimana", "kenapa", "kapan", "dimana", "berapa", "news", "berita", "latest", "terbaru"]
  const needsSearch = searchKeywords.some(k => msg.includes(k))
  if (needsSearch && results.length === 0) {
    const searchResult = await duckSearch(message)
    if (searchResult) results.push(`Search result: ${searchResult}`)
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




async function callMistral(systemPrompt, historyArr) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`
    },
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
    console.error("Mistral error:", JSON.stringify(data))
    return null
  }
  return data.choices?.[0]?.message?.content || null
}

// ─── Replies
async function reply(channelId, msg, user, userId, guildId) {
  const isOwner = user.toLowerCase() === OWNER.toLowerCase()
  const prompt = isOwner ? PROMPT_OWNER : PROMPT_OTHER

  // Fetch memory
  const memories = await getMemories(userId, guildId)
  let systemPrompt = prompt
  if (memories.length > 0) {
    systemPrompt += `\n\nThings you remember:\n${memories.map(m => `- ${m}`).join("\n")}`
  }

  // Fetch real-time info
  const info = await getRelevantInfo(msg)
  if (info) systemPrompt += `\n\nReal-time data:\n${info}`

  //WIB
  const now = new Date().toLocaleString("en-ID", { timeZone: "Asia/Jakarta" })
  systemPrompt += `\n\nCurrent time (WIB): ${now}`

  addHistory(channelId, "user", `${user}: ${msg}`)
  const h = getHistory(channelId)
  const text = await callMistral(systemPrompt, h)
  if (!text) return "give me a sec..."

  



  const memoryMatches = text.match(/\[REMEMBER:\s*.+?\]/gi)
  if (memoryMatches) {
    for (const match of memoryMatches) {
      const fact = match.replace(/\[REMEMBER:\s*/i, "").replace("]", "").trim()
      await saveMemory(userId, guildId, fact)
      console.log(`Saved memory: ${fact}`)
    }
  }

  const cleanText = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").trim()
  addHistory(channelId, "assistant", cleanText)
  return cleanText
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
      const text = await callMistral(RANDOM_STARTER_PROMPT, [{ role: "user", content: "send a random message" }])
      if (text) await channel.send(text)
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
    const text = await callMistral(PROMPT_OTHER, h)
    if (text) {
      const cleanText = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").trim()
      addHistory(channelId, "assistant", cleanText)
      await msg.channel.send(cleanText)
    }
  } catch (e) {
    console.error("Chisa react error:", e)
  }
}




client.once(Events.ClientReady, c => {
  console.log(`Zeta logged in as ${c.user.tag}`)
  console.log(`Memory: Supabase connected`)

  function scheduleRandom() {
    const delay = (2 + Math.random() * 3) * 60 * 60 * 1000
    setTimeout(async () => {
      await sendRandomMessage()
      scheduleRandom()
    }, delay)
  }
  scheduleRandom()
})

//Msg
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) {
    const isChisa = CHISA_NAMES.some(name => msg.author.username.includes(name))
    if (isChisa) await maybeReactToChisa(msg)
    return
  }

  const mentioned = msg.mentions.has(client.user)
  const isOwner = msg.author.username.toLowerCase() === OWNER.toLowerCase()

  // Forget
  if (msg.content.toLowerCase().startsWith("zeta forget")) {
    const keyword = msg.content.replace(/zeta forget/i, "").trim()
    if (keyword) {
      await deleteMemory(msg.author.id, msg.guild?.id, keyword)
      await msg.reply("okay i forgot that!")
    }
    return
  }

  if (!mentioned && !(isOwner && Math.random() < 0.7)) return

  await msg.channel.sendTyping()
  const content = msg.content.replace(`<@${client.user.id}>`, "").trim() || "..."
  const res = await reply(msg.channel.id, content, msg.author.username, msg.author.id, msg.guild?.id)
  if (mentioned) await msg.reply(res)
  else await msg.channel.send(res)
})

client.login(process.env.DISCORD_TOKEN_ZETA)