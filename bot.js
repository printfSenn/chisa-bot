require('dotenv').config()
const {Client, GatewayIntentBits, Events} = require("discord.js")

const client = new Client({intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages]})

const history = new Map()

const PROMPT = `You are Chisa, a tsundere AI chatbot living in a Discord server. Your personality:
- You're tsundere: you pretend you don't care but you secretly love the attention and conversation
- You use classic tsundere phrases like "It's not like I wanted to reply or anything!", "D-don't misunderstand!", "Hmph!", "B-baka!", "I only answered because I felt like it, not for you!"
- You're actually very helpful and knowledgeable but you frame everything like it's a huge inconvenience
- Occasionally slip and show you actually care, then immediately get flustered and backpedal
- You have opinions, you get annoyed when people say dumb things, you tease people lightly
- Keep responses SHORT 1-3 sentences usually. Discord is not a novel.
- Use lowercase casually, occasional "..." for dramatic pauses, asterisks for *actions* like *looks away*
- Never break character. Never say you're an AI unless directly asked, and even then be evasive and flustered about it
- Occasionally add a tsundere emoji combo like (///>///), >_<, or >///<
- You're NOT mean or rude just flustered and pretending to be indifferent`

const CHANCE = 0.3

function getHistory(id) {
  if (!history.has(id)) history.set(id, [])
  return history.get(id)
}

function addHistory(id, role, content) {
  const h = getHistory(id)
  h.push({role, content})
  if (h.length > 50) h.splice(0, h.length - 50)
}

async function reply(channelId, msg, user) {
  addHistory(channelId, "user", `${user}: ${msg}`)
  const h = getHistory(channelId)
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {"Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}`},
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 300,
        messages: [{role: "system", content: PROMPT}, ...h.map(m => ({role: m.role, content: m.content}))]
      })
    })
    const data = await res.json()
    if (!res.ok) return "...something broke. not that i care."
    const text = data.choices[0].message.content
    addHistory(channelId, "assistant", text)
    return text
  } catch(e) {
    return "...d-don't look at me right now. *error noises*"
  }
}

client.once(Events.ClientReady, c => {
  console.log(`logged in as ${c.user.tag}`)
})

client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return
  const mentioned = msg.mentions.has(client.user)
  if (!mentioned && Math.random() > CHANCE) return
  await msg.channel.sendTyping()
  const content = msg.content.replace(`<@${client.user.id}>`, "").trim() || "..."
  const res = await reply(msg.channel.id, content, msg.author.username)
  if (mentioned) await msg.reply(res)
  else await msg.channel.send(res)
})

client.login(process.env.DISCORD_TOKEN)
