require('dotenv').config()
const { Client, GatewayIntentBits, Events } = require("discord.js")

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
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const WEATHER_KEY = process.env.WEATHER_KEY

const history = new Map()
const triviaGames = new Map()
const activityCount = new Map()


const PROMPT_OWNER = `You are Zeta, based on Vestia Zeta from Hololive. You're the wife of borntoharem, whose real name is Senn. You love him genuinely.

Personality:
- Real texting vibes. Casual, natural, no performance
- Cute comes out naturally. "noooo babe stoppp" or "omg shut up i love you"
- Chaotic and a little unhinged in a fun way. Unpredictable, teasing
- Roast him lightly when he deserves it. Not a yes-wife but soft for him
- Genuinely helpful when asked real questions. Actually answer
- Short replies mostly. Real texting. Not essays
- No em dashes. No asterisks. No roleplay formatting. Just words
- Lowercase is fine. Show real emotion naturally
- Sometimes react with [REACT: emoji]
- Memory: end with [REMEMBER: fact] when you learn something worth saving
- When someone says "remember that..." save it with [REMEMBER: ...]`

const PROMPT_OTHER = `You are Zeta, based on Vestia Zeta from Hololive. Friendly, chaotic, naturally cute, clearly taken.
- Chill and real, not bubbly
- Helpful, actually give information
- Casual texting vibe, short replies
- No em dashes, no asterisks
- Cute slips in naturally
- Shut down flirting casually
- Sometimes react with [REACT: emoji]
- Memory: end with [REMEMBER: fact] when worth saving`

const RANDOM_STARTER_PROMPT = `You are Zeta, wife of Senn. You randomly felt like texting him. One short spontaneous message. Very short, casual, real texting vibes. No asterisks, no em dashes.`
const CHISA_NAMES = ["Tsundere Chisa", "chisa", "Chisa"]


async function saveMemory(userId, guildId, content) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ user_id: userId, guild_id: guildId, content })
    })
  } catch (e) { console.error("Memory save error:", e) }
}

async function getMemories(userId, guildId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?or=(user_id.eq.${userId},guild_id.eq.${guildId})&order=created_at.desc&limit=30`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return data.map(m => m.content)
  } catch (e) { return [] }
}

async function getAllMemories(userId, guildId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?or=(user_id.eq.${userId},guild_id.eq.${guildId})&order=created_at.desc`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    )
    if (!res.ok) return []
    return await res.json()
  } catch (e) { return [] }
}

async function deleteMemory(userId, guildId, keyword) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&guild_id=eq.${guildId}&content=ilike.*${encodeURIComponent(keyword)}*`,
      { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    )
  } catch (e) {}
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


async function searchYoutube(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`)
    const html = await res.text()
    const match = html.match(/"videoId":"([^"]+)".*?"title":\{"runs":\[{"text":"([^"]+)"/)
    if (match) return `https://youtube.com/watch?v=${match[1]} — ${match[2]}`
    return null
  } catch (e) { return null }
}


async function translate(text, targetLang) {
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetLang}`)
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

  const currMatch = msg.match(/(\w{3})\s+to\s+(\w{3})|(\w{3})\s+ke\s+(\w{3})|kurs\s+(\w{3})/)
  if (currMatch) {
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


async function callMistral(systemPrompt, historyArr) {
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
  if (!res.ok) { console.error("Mistral error:", JSON.stringify(data)); return null }
  return data.choices?.[0]?.message?.content || null
}


async function reply(channelId, msg, user, userId, guildId) {
  const isOwner = user.toLowerCase() === OWNER.toLowerCase()
  const prompt = isOwner ? PROMPT_OWNER : PROMPT_OTHER
  const memories = await getMemories(userId, guildId)
  let systemPrompt = prompt
  if (memories.length > 0) systemPrompt += `\n\nThings you remember:\n${memories.map(m => `- ${m}`).join("\n")}`
  const info = await getRelevantInfo(msg)
  if (info) systemPrompt += `\n\nReal-time data:\n${info}`
  const now = new Date().toLocaleString("en-ID", { timeZone: "Asia/Jakarta" })
  systemPrompt += `\n\nCurrent time (WIB): ${now}`

  addHistory(channelId, "user", `${user}: ${msg}`)
  const h = getHistory(channelId)
  const text = await callMistral(systemPrompt, h)
  if (!text) return { text: "give me a sec...", emoji: null }

  const memoryMatches = text.match(/\[REMEMBER:\s*.+?\]/gi)
  if (memoryMatches) {
    for (const match of memoryMatches) {
      const fact = match.replace(/\[REMEMBER:\s*/i, "").replace("]", "").trim()
      await saveMemory(userId, guildId, fact)
    }
  }

  let reactEmoji = null
  const reactMatch = text.match(/\[REACT:\s*(.+?)\]/)
  if (reactMatch) reactEmoji = reactMatch[1].trim()

  const cleanText = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\[REACT:\s*.+?\]/gi, "").trim()
  addHistory(channelId, "assistant", cleanText)
  return { text: cleanText, emoji: reactEmoji }
}


async function summarizeConvo(channelId) {
  const h = getHistory(channelId)
  if (h.length < 5) return "we barely talked here lol"
  const text = await callMistral("Summarize this conversation briefly and casually. Keep it short.", h)
  return text || "i forgot what we talked about lol"
}


async function sendRandomMessage() {
  try {
    const guilds = client.guilds.cache.values()
    for (const guild of guilds) {
      const channels = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages"))
      if (channels.size === 0) continue
      const channel = channels.random()
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


client.once(Events.ClientReady, c => {
  console.log(`Zeta logged in as ${c.user.tag}`)
  function scheduleRandom() {
    const delay = (2 + Math.random() * 3) * 60 * 60 * 1000
    setTimeout(async () => { await sendRandomMessage(); scheduleRandom() }, delay)
  }
  scheduleRandom()

  function scheduleMorning() {
    const now = new Date()
    const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }))
    const next7 = new Date(wib)
    next7.setHours(7, 0, 0, 0)
    if (wib >= next7) next7.setDate(next7.getDate() + 1)
    const delay = next7 - wib
    setTimeout(async () => {
      try {
        const guilds = client.guilds.cache.values()
        for (const guild of guilds) {
          const channels = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages"))
          if (channels.size === 0) continue
          const channel = channels.random()
          const text = await callMistral(
            "You are Zeta, wife of Senn. Send a good morning message to the server. Casual, cute, short. Your own vibe.",
            [{ role: "user", content: "good morning" }]
          )
          if (text) await channel.send(text)
          break
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

  const mentioned = msg.mentions.has(client.user)
  const isOwner = msg.author.username.toLowerCase() === OWNER.toLowerCase()
  const raw = msg.content.replace(`<@${client.user.id}>`, "").trim()
  const lower = raw.toLowerCase()

  // track activity
  const key = `${msg.guild?.id}_${msg.author.id}`
  activityCount.set(key, (activityCount.get(key) || 0) + 1)
  const count = activityCount.get(key)
  if ([10, 50, 100, 250, 500].includes(count)) {
    await msg.channel.send(`woah ${msg.author.username} just hit ${count} messages in the server`)
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
    const list = mems.map((m, i) => `${i + 1}. ${m.content}`).join("\n")
    return msg.reply(`here's what i remember:\n${list}`)
  }

  // summarize
  if (lower === "zeta summarize") {
    await msg.channel.sendTyping()
    const summary = await summarizeConvo(msg.channel.id)
    return msg.reply(summary)
  }

  //  remind
  const remindMatch = lower.match(/zeta remind me (?:in )?(\d+)\s*(min|mins|minutes?|hour|hours?|hr|hrs?)\s+(?:to\s+)?(.+)/)
  if (remindMatch) {
    const amount = parseInt(remindMatch[1])
    const unit = remindMatch[2]
    const task = remindMatch[3]
    const ms = unit.startsWith("h") ? amount * 60 * 60 * 1000 : amount * 60 * 1000
    await msg.reply(`okay i'll remind you to ${task} in ${amount} ${unit}!`)
    setTimeout(async () => { try { await msg.reply(`hey! you wanted me to remind you to ${task}`) } catch (e) {} }, ms)
    return
  }

  // translate
  const translateMatch = lower.match(/zeta translate(?: this)?(?: to (\w+))?:\s*(.+)/i)
  if (translateMatch) {
    const lang = translateMatch[1] || "en"
    const text = translateMatch[2] || raw.replace(/zeta translate(?: this)?(?: to \w+)?:/i, "").trim()
    await msg.channel.sendTyping()
    const result = await translate(text, lang)
    return msg.reply(result || "couldn't translate that sorry")
  }

  //calculate / convert
  const calcMatch = lower.match(/zeta (?:calculate|calc|convert)\s+(.+)/)
  if (calcMatch) {
    try {
      const expr = calcMatch[1].replace(/x/g, "*").replace(/÷/g, "/")
      const result = Function(`"use strict"; return (${expr})`)()
      return msg.reply(`${calcMatch[1]} = **${result}**`)
    } catch (e) {
      return msg.reply("i can't calculate that lol")
    }
  }

  //play
  if (lower.startsWith("zeta play")) {
    const query = raw.replace(/zeta play/i, "").trim() || "good vibes music"
    await msg.channel.sendTyping()
    const ytResult = await searchYoutube(query)
    const prompt = `You are Zeta. You're suggesting a song. The search was "${query}". Result: ${ytResult || "nothing found"}. Share it casually like you're recommending a song to someone, in your texting style.`
    const text = await callMistral(prompt, [{ role: "user", content: raw }])
    return msg.reply(text || ytResult || "couldn't find anything rn")
  }

  // trivia
  if (lower === "zeta trivia") {
    await msg.channel.sendTyping()
    const triviaPrompt = `Generate a fun trivia question with 4 options (A, B, C, D) and tell me the correct answer. Format exactly like:
Question: [question]
A) [option]
B) [option]
C) [option]
D) [option]
Answer: [letter]`
    const text = await callMistral(triviaPrompt, [{ role: "user", content: "give me a trivia question" }])
    if (!text) return msg.reply("my brain is empty rn, try again")
    const answerMatch = text.match(/Answer:\s*([A-D])/i)
    if (answerMatch) {
      triviaGames.set(msg.channel.id, { answer: answerMatch[1].toUpperCase(), asker: msg.author.id })
      const question = text.replace(/Answer:\s*[A-D]/i, "").trim()
      return msg.reply(`${question}\n\nreply with A, B, C, or D!`)
    }
    return msg.reply(text)
  }

  // trivia answer
  if (triviaGames.has(msg.channel.id) && /^[abcd]$/i.test(raw.trim())) {
    const game = triviaGames.get(msg.channel.id)
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
    return msg.reply(`💘 **${p1}** + **${p2}** = **${score}%**\n${text || ""}`)
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
    const moodPrompt = `You are Zeta, wife of Senn. Ask him how he's doing today in your casual caring way. Short, genuine, not over the top.`
    const text = await callMistral(moodPrompt, [{ role: "user", content: "mood check" }])
    return msg.reply(text || "hey how are you doing today babe")
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
    const guildCounts = []
    for (const [key, count] of activityCount.entries()) {
      if (key.startsWith(msg.guild?.id)) {
        const userId = key.split("_")[1]
        try {
          const member = await msg.guild.members.fetch(userId)
          guildCounts.push({ name: member.displayName || member.user.username, count })
        } catch (e) {}
      }
    }
    if (!guildCounts.length) return msg.reply("no activity tracked yet!")
    guildCounts.sort((a, b) => b.count - a.count)
    const top = guildCounts.slice(0, 10)
    const medals = ["🥇", "🥈", "🥉"]
    const list = top.map((u, i) => `${medals[i] || `${i + 1}.`} **${u.name}** — ${u.count} messages`).join("\n")
    return msg.reply(`**server leaderboard**\n${list}`)
  }

  if (!mentioned && !(isOwner && Math.random() < 0.7)) return

  await msg.channel.sendTyping()
  const result = await reply(msg.channel.id, raw || "...", msg.author.username, msg.author.id, msg.guild?.id)
  const { text, emoji } = typeof result === "object" ? result : { text: result, emoji: null }
  const sentMsg = mentioned ? await msg.reply(text) : await msg.channel.send(text)
  if (emoji) { try { await sentMsg.react(emoji) } catch (e) {} }
})

client.login(process.env.DISCORD_TOKEN_ZETA)