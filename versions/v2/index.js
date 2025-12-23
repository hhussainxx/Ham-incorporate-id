// index.js - unified staging + flexible count parser (updated)
const { Client, GatewayIntentBits, Partials, ChannelType } = require("discord.js");
const fs = require("fs");

// load config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// utils

function now() { return Date.now(); }
async function debugDC(text) {
    try {
        if (!config.debug_channel) return;
        const ch = client.channels.cache.get(config.debug_channel);
        if (!ch) return;
        await ch.send("```" + String(text) + "```");
    } catch (e) {
        console.log("[debugDC error]", e.message);
    }
}

// session & staging stores
const sessions = new Map();              // code -> session
const lastSessionForServer = new Map();  // guildId -> code
const staging = new Map();               // guildId -> { code, have, pingSeen, timers, createdAt, reused }

// persisted/recent code memory for reuse
const lastCodes = new Map();            // guildId -> { code, ts }
const lastCodeByUser = new Map();       // guildId -> Map(userId -> { code, ts })

// defaults (config overrideable)
const WAIT_FOR_CODE_MS = config.wait_for_code_ms ?? 120000; // 2 minutes
const WAIT_FOR_COUNT_MS = config.wait_for_count_ms ?? 10 * 60 * 1000; // 10 minutes
const POST_FULL_DELAY_MS = config.post_full_delay_ms ?? 7000; // 7 seconds
const INACTIVITY_MS = config.session_timeout_ms ?? 3600000; // 1 hour
const LAST_CODE_TTL_MS = config.last_code_ttl_ms ?? (3 * 60 * 60 * 1000); // 3 hours


// prevent dups temp for the same code
function getActiveSessionByCode(code) {
    if (!code) return null;
    return sessions.get(code) || null;
}

// helper: region ping role for a guild
function getRegionPingRole(guildId) {
    const server = config.servers[guildId];
    if (!server || !server.region) return null;
    const region = server.region.toLowerCase();
    return config.relay_region_pings?.[region] || null;
}

// create temp channel
async function createTempChannel(code) {
    const relayGuildId = config.relay_guild;
    const categoryId = config.relay_temp_category;

    const relayGuild = client.guilds.cache.get(relayGuildId);
    if (!relayGuild) throw new Error("relay guild missing");

    const safeCode = String(code).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const base = "the-gathering-begins";
    let name = `${base}-${safeCode}`.slice(0, 90);

    let index = 1;
    while (relayGuild.channels.cache.find(c => c.name === name && c.parentId === categoryId)) {
        index += 1;
        name = `${base}-${safeCode}-${index}`.slice(0, 90); // temp channel name
        if (index > 50) break;
    }

    const opts = { type: ChannelType.GuildText, parent: categoryId, reason: `temp channel for code ${code}` };
    const ch = await relayGuild.channels.create({ name, ...opts });
    return ch.id;
}

// send helper - content must include any role mentions required
async function sendPlainToChannel(channelId, text, components = []) {
    const ch = client.channels.cache.get(channelId);
    if (!ch) return;
    await ch.send({ content: text, allowedMentions: { roles: Object.values(config.relay_region_pings || {}) }, components }).catch(() => null);
}

// drekar delete button row
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

// server name and invites messages
function serverLabelMessagesForGuild(guildId) {
    const s = config.servers[guildId];
    if (!s) return [];
    if (s.invite) return [`[${s.name}]`, `<${s.invite}>`];
    return [`[${s.name}]`];
}

// count parser - permissive
const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function wordsToNum(w) { w = String(w).toLowerCase(); return WORD_NUM[w] ?? null; }

function extractPlayerCountFromText(text) {
    if (!text) return null;
    const t = text.toLowerCase().replace(/[,!.?]/g, " ");

    // ignore questions
    if (/\b(are\s+(you|u|we)|do\s+(you|u|we)|is\s+(it|the)|i\s+assume|assuming|maybe|might\s+be|could\s+be|if\s+(you|u)\s+don'?t\s+get)\b|\?/.test(t)) return null;

    // full detection
    if (/\b(full|lobby full|full lobby|we're full|we are full)\b/.test(t) || /\b6\s*\/\s*6\b/.test(t)) return 6;

    // x/6
    let m = t.match(/(\d{1})\s*\/\s*6/);
    if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 6) return n; }

    // 6 of 6 variants
    m = t.match(/(\d)\s*(?:of|out of)\s*6/);
    if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 6) return n; }

    // have x / we have x / got x / x players / currently have x / currently x
    m = t.match(/\b(?:we have|we're|we are|have|got|currently|currently have|we are)\s+(\d{1,2}|\w+)\b/);
    if (m) { let raw = m[1]; let n = parseInt(raw, 10); if (isNaN(n)) n = wordsToNum(raw); if (n >= 1 && n <= 6) return n; }

    // "x players"
    m = t.match(/\b(\d{1,2}|\w+)\s+players?\b/);
    if (m) { let raw = m[1]; let n = parseInt(raw, 10); if (isNaN(n)) n = wordsToNum(raw); if (n >= 1 && n <= 6) return n; }

    // need x / i need x / we need x / need x more
    m = t.match(/(?:i need|we need|need)\s+(\d{1,2}|\w+)(?:\s*more)?\b/);
    if (m) { let raw = m[1]; let x = parseInt(raw, 10); if (isNaN(x)) x = wordsToNum(raw); if (x >= 0 && x <= 5) { if (x === 0) return null; const have = 6 - x; if (have >= 1 && have <= 6) return have; } }

    //treat +x as need x more => have = 6 - x
    m = t.match(/(?:\+|plus)\s*([0-9])/);
    if (m) { const x = parseInt(m[1], 10); if (x === 0) return null; if (x >= 1 && x <= 5) return 6 - x; }

    return null;
}

// extract code - flexible pattern
function extractCode(text) {
    if (!text) return null;
    const CODE_REGEX = /\b([A-Z][a-z]{3,10}){3}\b/;  // game code
    const match = text.match(CODE_REGEX);
    return match ? match[0] : null;
}

// memory helpers
function storeLastCodeForGuildAndUser(guildId, code, userId) {
    if (!guildId || !code) return;
    lastCodes.set(guildId, { code, ts: now() });
    if (!lastCodeByUser.has(guildId)) lastCodeByUser.set(guildId, new Map());
    lastCodeByUser.get(guildId).set(userId, { code, ts: now() });
}

function getReusableCodeForGuildAndUser(guildId, userId) {
    const userMap = lastCodeByUser.get(guildId);
    if (userMap && userMap.has(userId)) {
        const rec = userMap.get(userId);
        if (now() - rec.ts <= LAST_CODE_TTL_MS) return rec.code;
    }
    const g = lastCodes.get(guildId);
    if (g && now() - g.ts <= LAST_CODE_TTL_MS) return g.code;
    return null;
}

async function updatePlayerCountForSession(session, count, originGuildId = null, rawText = "") {
    try {
        console.log("DEBUG: entering updatePlayerCountForSession try-block");
        console.log("DEBUG: updatePlayerCountForSession invoked", {
            sessionCode: session.code,
            count,
            originGuildId,
            originCfg: originGuildId ? config.servers[originGuildId] : null
        });

        session.lastActivity = now();
        count = Math.max(1, Math.min(6, Number(count) || 1));

        if (session.lastPlayers === count) {
            debugDC(`duplicate player count prevented for ${session.code}: ${count}/6`);
            return;
        }
        session.lastPlayers = count;

        let formatted = "";
        const originCfg = originGuildId ? config.servers[originGuildId] : null;

        console.log("DEBUG: originCfg resolved", {
            originGuildId,
            originCfg,
            ping_role: originCfg?.ping_role
        });

        if (originCfg) {
            const region = originCfg.region;
            const relayRegionRoleId =
                region && config.relay_region_pings?.[region]
                    ? config.relay_region_pings[region]
                    : null;

            const roleMention = relayRegionRoleId ? `<@&${relayRegionRoleId}> ` : "";
            formatted = `${roleMention}code: ${session.code} | ${count}/6`;

            console.log("DEBUG: formatted line generated", { formatted });
        } else {
            formatted = `code: ${session.code} | ${count}/6`;
        }

        if (session.tempChannelId) {
            await sendPlainToChannel(session.tempChannelId, formatted).catch(() => null);
        }

        debugDC(
            "PLAYER COUNT UPDATE DEBUG\n" +
            "----------------------------------------\n" +
            `session_code:           ${session.code}\n` +
            `session_id:             ${session.id}\n` +
            `count:                  ${count}\n` +
            `raw_text:               "${rawText}"\n` +
            `\n` +
            `originGuildId:          ${originGuildId}\n` +
            `origin_server_name:     ${config.servers[originGuildId]?.name || "unknown"}\n` +
            `origin_region:          ${config.servers[originGuildId]?.region || "unknown"}\n` +
            `relay_region_role:      ${config.relay_region_pings?.[config.servers[originGuildId]?.region] || "none"}\n` +
            `configured_count_channel: ${config.servers[originGuildId]?.count_channel || "none"}\n` +
            `origin_channel:         ${session.originChannelId || "unknown"}\n` +
            `\n` +
            `tempChannelId:          ${session.tempChannelId}\n` +
            `session.lastPlayers:    ${session.lastPlayers}\n` +
            `session.lastActivity:   ${session.lastActivity}\n` +
            "----------------------------------------"
        );



        if (count >= 6) {
            await sendPlainToChannel(session.tempChannelId, `full (6/6)`).catch(() => null);
            setTimeout(() => endSession(session, "session ended (full)"), POST_FULL_DELAY_MS);
        }
    } catch (e) {
        debugDC(`updatePlayerCountForSession error: ${e.message || e}`);
    }
}



// create session helper
async function createSessionFromStaging(guildId) {
    const s = staging.get(guildId);
    if (!s || !s.code) return null;

    // BLOCK DUPLICATE TEMP CHANNEL CREATION
    const existing = getActiveSessionByCode(s.code);
    if (existing) {
        clearStaging(guildId);

        // also auto-update the existing session if a new count arrives
        if (s.have !== null) {
            await updatePlayerCountForSession(existing, s.have, guildId);
        }

        return null;
    }


    if (!s.pingSeen || !s.code || s.have === null) return null;

    const code = s.code;
    const tempId = await createTempChannel(code).catch(err => { debugDC(`createTempChannel err ${err.message}`); return null; });
    if (!tempId) return null;

    const session = {
        code,
        tempChannelId: tempId,
        originChannelId: s.originChannelId,
        servers: new Set([guildId]),
        createdAt: now(),
        lastActivity: now(),
        ggsSenders: new Set(),
        timeout: null,
        originalCodeMsgId: null,
        lastPlayers: null
    };

    sessions.set(code, session);
    lastSessionForServer.set(guildId, code);

    // send labels and intro and delete button
    const labels = serverLabelMessagesForGuild(guildId);
    for (const m of labels) await sendPlainToChannel(tempId, m).catch(() => null);
    await sendPlainToChannel(tempId, "If the custom game lobby has reached its **full** six, players, then this channel has served its purpose. **Close it** to maintain order.");
    await sendPlainToChannel(tempId, "", drekarDeleteButtonRow());



    // region ping role and code post; capture message id for later edits
    const ch = client.channels.cache.get(tempId);
    let disclaimer = "";
    if (s.reused) disclaimer = "\n*(reused from earlier; verify if needed)*";

    // if code was reused, add disclaimer
    try {
        const players = s.have !== null ? s.have : 1;
        let msg;

        if (regionRole) {
            msg = `<@&${regionRole}> code: ${code} | ${players}/6${disclaimer}`;
        } else {
            msg = `code: ${code} | ${players}/6${disclaimer}`;
        }

        const m = await ch.send({ content: msg });
        session.originalCodeMsgId = m.id;

    } catch (e) {

    }

    // also forward initial count if present
    if (s.have !== null) {
        await updatePlayerCountForSession(session, s.have, guildId, s.rawText || "");
    }

    // start inactivity timer
    session.timeout = setTimeout(() => endSession(session, "session ended (inactive)"), INACTIVITY_MS);

    // clear staging for guild
    clearStaging(guildId);

    // if count is full, end session after short delay
    if (s.have >= 6) {
        setTimeout(() => endSession(session, "session ended (full, 6/6)"), POST_FULL_DELAY_MS);
    }

    return session;
}

function clearStaging(guildId) {
    const s = staging.get(guildId);
    if (!s) return;
    if (s.timers) {
        if (s.timers.pingCodeTimer) clearTimeout(s.timers.pingCodeTimer);
        if (s.timers.countTimer) clearTimeout(s.timers.countTimer);
    }
    staging.delete(guildId);
}

// when ping+code both present -> start count timer
function promoteToCountWait(guildId) {
    const s = staging.get(guildId);
    if (!s) return;
    if (s.timers && s.timers.pingCodeTimer) {
        clearTimeout(s.timers.pingCodeTimer);
        s.timers.pingCodeTimer = null;
    }
    s.timers = s.timers || {};
    if (s.timers.countTimer) clearTimeout(s.timers.countTimer);
    s.timers.countTimer = setTimeout(() => {
        debugDC(`count wait expired for guild ${guildId}`);
        clearStaging(guildId);
    }, WAIT_FOR_COUNT_MS);
}

// message handler
client.on("messageCreate", async (msg) => {
    try {
        if (msg.author.bot) return;
        if (!msg.guild) return;
        if (!config.servers[msg.guild.id]) return;

        const guildId = msg.guild.id;
        const serverCfg = config.servers[guildId];
        const raw = msg.content ? msg.content.trim() : "";
        if (extractPlayerCountFromText(raw) !== null) {
            console.log("DEBUG: count-like message detected", {
                raw,
                guildId,
                channelId: msg.channel.id,
                count: extractPlayerCountFromText(raw)
            });
        }

        console.log("DEBUG: at start of filter", {
            msgGuild: msg.guild.id,
            msgChannel: msg.channel.id,
            relayTempCategory: config.relay_temp_category,
            parentId: msg.channel.parentId
        });

        // filter out messages from the wrong channels
        if (serverCfg.count_channel) {
            if (msg.channel.id !== serverCfg.count_channel) {
                // check using the same parser the bot uses for counts
                const maybeCount = extractPlayerCountFromText(raw);

                if (maybeCount !== null) {

                    console.log("DEBUG: blocked by count_channel filter", {
                        raw,
                        guildId,
                        expected: serverCfg.count_channel,
                        actual: msg.channel.id
                    });
                    return;
                }

            }
        }


        // detect role ping robustly
        const hasRolePing = msg.mentions.roles.has(serverCfg.ping_role) || raw.includes(`<@&${serverCfg.ping_role}>`) || raw.includes(`<@${serverCfg.ping_role}>`);

        // extract code and possible count
        const code = extractCode(raw);
        const have = extractPlayerCountFromText(raw); // null or 1..6

        // record code memory if a user posts a code
        if (code) storeLastCodeForGuildAndUser(guildId, code, msg.author.id);

        // staging object ensure
        let s = staging.get(guildId);
        if (!s) {
            s = { code: null, have: null, pingSeen: false, timers: {}, createdAt: null, reused: false };
            staging.set(guildId, s);
        }

        s.originChannelId = msg.channel.id;
        s.rawText = raw;

        // handle role ping (with or without code)
        if (hasRolePing) {
            s.pingSeen = true;
            s.createdAt = s.createdAt || now();

            if (!s.timers.pingCodeTimer) {
                s.timers.pingCodeTimer = setTimeout(() => {
                    clearStaging(guildId);
                }, WAIT_FOR_CODE_MS);
            }
        }

        // if message includes code
        if (code) {
            // if there is an active session for this guild, update its code message if needed
            const last = lastSessionForServer.get(guildId);
            if (last && sessions.has(last)) {
                const session = sessions.get(last);
                if (session && session.originalCodeMsgId && session.tempChannelId) {
                    try {
                        const ch = client.channels.cache.get(session.tempChannelId);
                        const origMsg = await ch.messages.fetch(session.originalCodeMsgId).catch(() => null);
                        if (origMsg) {
                            // if code equals session.code -> remove disclaimer
                            if (code === session.code) {
                                const newContent = origMsg.content.replace(/\n\*\(possibly reused[\s\S]*?\)\*/i, "");
                                if (newContent !== origMsg.content) await origMsg.edit(newContent).catch(() => null);
                                // refresh memory for user/guild
                                storeLastCodeForGuildAndUser(guildId, code, msg.author.id);
                            } else {
                                // different code -> replace original message content and update session
                                const regionRole = getRegionPingRole(guildId);
                                const base = regionRole ? `<@&${regionRole}> code: ${code}` : `code: ${code}`;
                                await origMsg.edit(base).catch(() => null);
                                session.code = code;
                                storeLastCodeForGuildAndUser(guildId, code, msg.author.id);
                            }
                        }
                    } catch (e) {
                        debugDC(`failed to update original code message: ${e.message}`);
                    }
                }
            }

            s.code = code;
            s.createdAt = s.createdAt || now();

            if (s.pingSeen) promoteToCountWait(guildId);
            else if (!s.timers.pingCodeTimer) {
                s.timers.pingCodeTimer = setTimeout(() => { debugDC(`ping+code wait expired for guild ${guildId}`); clearStaging(guildId); }, WAIT_FOR_CODE_MS);
            }
        }

        // if message contains count info
        if (have !== null) {
            if (s.code && s.pingSeen) {
                s.have = have;
                await createSessionFromStaging(guildId);
                return;
            }

            // else store and keep waiting
            s.have = have;

            // attempt reuse: if ping present and no code, try to auto-fill from memory
            if (!s.code && s.pingSeen && !code && s.have !== null) {
                const reused = getReusableCodeForGuildAndUser(guildId, msg.author.id);
                if (reused) {
                    s.code = reused;
                    s.reused = true;
                    debugDC(`reused code ${reused} for guild ${guildId} from memory`);
                    await createSessionFromStaging(guildId);
                    return;
                }
            }
        }

        // if we have all three (ping,code, player-count) present -> create session
        if (s.code && s.pingSeen && s.have !== null) {
            await createSessionFromStaging(guildId);
            return;
        }

        // if message had both ping+code in same message
        if (hasRolePing && code) return;

        // route counts to existing sessions fallback (lastSessionForServer)
        if ((!s.code && !s.pingSeen) && have !== null) {
            let target = null;
            if (sessions.size === 1) target = [...sessions.values()][0];
            else {
                const last = lastSessionForServer.get(guildId);
                if (last && sessions.has(last)) target = sessions.get(last);
            }

            console.log("DEBUG: routing fallback count", {
                raw,
                guildId,
                have,
                targetSessionCode: target?.code,
                targetSessionOriginGuildId: guildId
            });

            if (target) {
                await updatePlayerCountForSession(target, have, guildId, raw);
                if (have >= 6) {
                    await sendPlainToChannel(target.tempChannelId, `full (6/6)`).catch(() => null);
                    setTimeout(() => endSession(target, "session ended (full)"), POST_FULL_DELAY_MS);
                }
                return;
            }
        }

    } catch (err) {
        console.log("message handler error", err.message);
        console.log("DEBUG: error inside updatePlayerCountForSession", err);

    }
});

// session count updates originating from within active sessions (normal flow)
async function forwardCountMessageToSession(guildId, count) {
    const last = lastSessionForServer.get(guildId);
    if (last && sessions.has(last)) {
        const session = sessions.get(last);
        await updatePlayerCountForSession(session, count, guildId);
        if (count >= 6) {
            await sendPlainToChannel(session.tempChannelId, `full (6/6)`).catch(() => null);
            setTimeout(() => endSession(session, "session ended (full)"), POST_FULL_DELAY_MS);
        }
    }
}

//     store last code in guild memory on end (endSession)
async function endSession(session, reasonText, originGuildId = null) {
    try {
        if (session.tempChannelId) {
            const labels = serverLabelMessagesForGuild(originGuildId);
            for (const m of labels) await sendPlainToChannel(session.tempChannelId, m).catch(() => null);
            await sendPlainToChannel(session.tempChannelId, reasonText).catch(() => null);
            const ch = client.channels.cache.get(session.tempChannelId);
            if (ch && ch.deletable) await ch.delete().catch(() => null);
        }

        // store last code after channel deletion
        if (originGuildId && session && session.code) {
            lastCodes.set(originGuildId, { code: session.code, ts: now() });
        }

    } catch (e) {
        console.log("endSession error", e.message);
    } finally {
        if (session.timeout) clearTimeout(session.timeout);
        sessions.delete(session.code);
    }
}

// periodic inactivity enforcement
setInterval(() => {
    const cutoff = now() - INACTIVITY_MS;
    for (const session of sessions.values()) {
        if (session.lastActivity < cutoff) {
            endSession(session, "session ended (inactive)").catch(() => null);
        }
    }
}, 30000);

// ready
client.on("ready", () => {
    console.log(`logged in as ${client.user.tag}`);
});

// login
client.login(config.token);
