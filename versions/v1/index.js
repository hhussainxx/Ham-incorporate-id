import { Client, GatewayIntentBits } from "discord.js";
import fs from "fs";
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
const activeSessions = new Map();

client.on("messageCreate", async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;

    const guildId = msg.guild.id;
    const serverConf = config.servers[guildId];
    if (!serverConf) return; 

    const pingRoleId = serverConf.ping_role;
    const content = msg.content.trim();
    const channelId = msg.channel.id;

    if (msg.mentions.roles.has(pingRoleId)) {
        const code = extractCode(content);
        if (!code) return;

        activeSessions.set(channelId, { code, players: 1 });

        forward(msg, `<@&${pingRoleId}> ${code}`);
        console.log(`session started in ${channelId} with code ${code}`);
        return;
    }

    if (!activeSessions.has(channelId)) return;

    const session = activeSessions.get(channelId);
    const count = extractCount(content);
    if (count) {
        session.players = count;

        forward(msg, `${count}/6`);
        console.log(`count update ${count}/6 in ${channelId}`);

        if (count >= 6) {
            activeSessions.delete(channelId);
            console.log(`session in ${channelId} ended at 6/6`);
        }
        return;
    }
    const newCode = extractCode(content);
    if (newCode && newCode !== session.code) {
        activeSessions.set(channelId, { code: newCode, players: 1 });

        forward(msg, `new code: ${newCode}`);
        console.log(`session restarted in ${channelId} with code ${newCode}`);
        return;
    }
    forward(msg, content);
});

function extractCode(text) {
    const regex = /\b[A-Z][a-z]+[A-Z][a-z]+[A-Z][a-z]+\b/;
    const match = text.match(regex);
    return match ? match[0] : null;
}

function extractCount(text) {
    const m = text.match(/^(\d)\/6$/);
    return m ? parseInt(m[1], 10) : null;
}

async function forward(msg, payload) {
    const relay = msg.client.channels.cache.get(config.relay_channel);
    if (!relay) {
        console.log("relay channel missing");
        return;
    }
    const serverName = config.servers[msg.guild.id]?.name || "unknown";
    await relay.send(`[${serverName}] ${payload}`);
}

client.login(config.token);
