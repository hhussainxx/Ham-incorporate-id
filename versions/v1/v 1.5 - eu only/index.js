const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require("discord.js");
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});


async function debugDC(text) {
    try {
        if (!config.debug_channel) return;
        const ch = client.channels.cache.get(config.debug_channel);
        if (!ch) return;
        await ch.send("```" + String(text) + "```");
    } catch (err) {
        console.log("[debugDC error]", err.message);
    }
}

const sessions = new Map();                
const lastSessionForServer = new Map();

function now() { return Date.now(); }

function serverLabelMessagesForGuild(guildId) {
    const s = config.servers[guildId];
    if (!s) return [];
    if (s.invite) {
        return [
            `[${s.name}]`,
            `<${s.invite}>`
        ];
    }
    return [`[${s.name}]`];
}

async function createTempChannel(code) {
    const relayGuildId = config.relay_guild;
    const categoryId = config.relay_temp_category;

    debugDC(`creating temp channel for ${code}`);

    const relayGuild = client.guilds.cache.get(relayGuildId);
    if (!relayGuild) throw new Error("relay guild missing");

    const name = `lobby-${code.toLowerCase()}`.slice(0, 90);
    const opts = {
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: `Temp channel for code ${code}`
    };

    const ch = await relayGuild.channels.create({ name, ...opts }).catch(err => { throw err; });
    return ch.id;
}

// supports optional components for buttons
async function sendPlainToChannel(channelId, text, ping = false, components = []) {
    const ch = client.channels.cache.get(channelId);
    if (!ch) return;

    if (ping) {
        await ch.send({
            content: `<@&${config.relay_ping_role}> ${text}`,
            allowedMentions: { roles: [config.relay_ping_role] },
            components
        }).catch(() => null);
    } else {
        await ch.send({ content: text, allowedMentions: { parse: [] }, components }).catch(() => null);
    }
}

function extractCode(text) {
    const CODE_REGEX = /([A-Z][a-z]{3,10}){3}/;  // game code
    const match = text.match(CODE_REGEX);
    return match ? match[0] : null;
}

function extractNeedCount(msg) {
    const match = msg.content.match(/(?:i need|need|we need)\s+(\d|one|two|three|four|five)/i); // i need x
    if (!match) return null;
    const raw = match[1].toLowerCase();
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    return map[raw] ?? parseInt(raw, 10);
}

function extractDirectCount(msg) {
    const m = msg.content.match(/(\d)\s*\/\s*6/);   // x/6
    if (!m) return null;
    return parseInt(m[1], 10);
}

function isPureGGs(text) {
    const t = text.toLowerCase().trim();
    return (t === "gg" || t === "ggs" || t === "gg everyone" || t === "ggs everyone");  // end session by ggs
}

async function updatePlayerCountForSession(session, count, originGuildId = null) {
    session.lastActivity = now();
    const payload = `${count}/6`;
    if (session.tempChannelId) {
        const labels = originGuildId ? serverLabelMessagesForGuild(originGuildId) : [];
        for (const m of labels) await sendPlainToChannel(session.tempChannelId, m, false).catch(() => null);
        await sendPlainToChannel(session.tempChannelId, payload, false).catch(() => null);
    }
    debugDC(`player count update: session=${session.code} count=${count}`);
}

function drekarDeleteButtonRow() {
    return [{
        type: 1,
        components: [{ type: 2, style: 4, custom_id: "drekar_delete", label: "delete channel" }]
    }];
}

client.on("interactionCreate", async (i) => {
    try {
        if (!i.isButton()) return;
        if (i.customId === "drekar_delete") {
            await i.reply({ content: "deleting channel...", ephemeral: true }).catch(() => null);
            // optional logging channel
            if (config.log_channel_id) {
                const log = i.guild.channels.cache.get(config.log_channel_id);
                if (log) log.send(`temp channel deleted: ${i.channel.name} by ${i.user.tag}`).catch(() => null);
            }
            await i.channel.delete().catch(() => null);
        }
    } catch (e) {
        console.log("interaction handler error", e.message);
    }
});

async function endSession(session, reasonText, originGuildId = null) {
    try {
        if (session.tempChannelId) {
            const labels = originGuildId ? serverLabelMessagesForGuild(originGuildId) : [];
            for (const m of labels) await sendPlainToChannel(session.tempChannelId, m, false).catch(() => null);
            await sendPlainToChannel(session.tempChannelId, reasonText, false).catch(() => null);
            const ch = client.channels.cache.get(session.tempChannelId);
            if (ch && ch.deletable) await ch.delete().catch(() => null);
        }
    } catch (e) {
        console.log("endSession error", e.message);
    } finally {
        if (session.timeout) clearTimeout(session.timeout);
        sessions.delete(session.code);
        debugDC(`session ended: code=${session.code} reason=${reasonText}`);
    }
}

// inactivity 
setInterval(() => {
    const timeoutMs = config.session_timeout_ms ?? 3600000;
    const cutoff = now() - timeoutMs;
    for (const session of sessions.values()) {
        if (session.lastActivity < cutoff) {
            endSession(session, "session ended (inactive)").catch(() => null);
        }
    }
}, 30000);

client.on("messageCreate", async (msg) => {
    try {
        if (msg.author.bot) return;
        if (!config.servers[msg.guild.id]) return;

        const guildId = msg.guild.id;
        const serverCfg = config.servers[guildId];
        const raw = msg.content;
        const lower = raw.toLowerCase();

        debugDC(`messageCreate: guild=${guildId} raw="${raw}"`);

        const rolePing = `<@&${serverCfg.ping_role}>`;
        const hasRolePing = raw.includes(rolePing);

        const code = extractCode(raw);

        // START / JOIN
        if (hasRolePing && code) {
            let session = sessions.get(code);
            if (!session) {
                // new session
                const tempId = await createTempChannel(code).catch(err => { debugDC(`createTempChannel err ${err.message}`); throw err; });
                session = { code, tempChannelId: tempId, servers: new Set([guildId]), createdAt: now(), lastActivity: now(), ggsSenders: new Set(), timeout: null };
                sessions.set(code, session);
                lastSessionForServer.set(guildId, code);

                const labels = serverLabelMessagesForGuild(guildId);
                for (const m of labels) await sendPlainToChannel(tempId, m, false).catch(() => null);

                await sendPlainToChannel(tempId, "if the custom lobby is full delete this chaneel.", false).catch(() => null);

                const row = drekarDeleteButtonRow();
                await sendPlainToChannel(tempId, "", false, row).catch(() => null);

                await sendPlainToChannel(tempId, `code: ${code}`, true).catch(() => null);

                // start inactivity timer
                const timeoutMs = config.session_timeout_ms ?? 3600000;
                session.timeout = setTimeout(() => endSession(session, "session ended (inactive)"), timeoutMs);

                debugDC(`start session: code=${code} guild=${guildId}`);
                return;
            }

            // join existing session (same code)
            session.servers.add(guildId);
            session.lastActivity = now();
            lastSessionForServer.set(guildId, code);

            const labels = serverLabelMessagesForGuild(guildId);
            for (const m of labels) await sendPlainToChannel(session.tempChannelId, m, false).catch(() => null);
            await sendPlainToChannel(session.tempChannelId, `code: ${code}`, true).catch(() => null);

            debugDC(`join session: code=${code} guild=${guildId}`);
            return;
        }

        // PLAYER COUNT ROUTING
        let targetSession = null;
        if (sessions.size === 1) targetSession = [...sessions.values()][0];
        else {
            const last = lastSessionForServer.get(guildId);
            if (last && sessions.has(last)) targetSession = sessions.get(last);
        }
        if (!targetSession) return;

        targetSession.lastActivity = now();
        if (targetSession.timeout) clearTimeout(targetSession.timeout);
        targetSession.timeout = setTimeout(() => endSession(targetSession, "session ended (inactive)"), config.session_timeout_ms ?? 3600000);

        // direct count
        const direct = extractDirectCount(msg);
        if (direct !== null) {
            await updatePlayerCountForSession(targetSession, direct, guildId);
            if (direct >= 6) { await updatePlayerCountForSession(targetSession, 6, guildId); await endSession(targetSession, "session ended (full)", guildId); }
            return;
        }

        // need X
        const need = extractNeedCount(msg);
        if (need !== null) {
            const have = 6 - need;
            await updatePlayerCountForSession(targetSession, have, guildId);
            if (have >= 6) { await updatePlayerCountForSession(targetSession, 6, guildId); await endSession(targetSession, "session ended (full)", guildId); }
            return;
        }

        // ggs
        if (isPureGGs(raw)) {
            targetSession.ggsSenders.add(msg.author.id);
            if (targetSession.ggsSenders.size >= 3) {
                await sendPlainToChannel(targetSession.tempChannelId, "session ended (ggs)", false).catch(() => null);
                await endSession(targetSession, "ended by ggs", guildId);
            }
            return;
        }

    } catch (err) {
        console.log("message handler error", err.message);
    }
});

client.on("ready", () => {
    console.log(`logged in as ${client.user.tag}`);
    debugDC(`bot ready in guilds: ${client.guilds.cache.map(g => `${g.name} (${g.id})`)}`);
});

// ---------------------
client.login(config.token);
// ---------------------
