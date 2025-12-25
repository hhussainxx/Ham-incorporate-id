require("dotenv").config();
const { Client, GatewayIntentBits, Partials, ChannelType } = require("discord.js");
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const crypto = require("crypto");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

const logStream = fs.createWriteStream("./console.log", { flags: "a" });
const origLog = console.log;

console.log = (...args) => {
    const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logStream.write(line + "\n");
    origLog(...args);
};

function now() { return Date.now(); }
async function debugDC(text) {
    try {
        if (!config.debug_channel) return console.log("[debug]", text);
        const ch = client.channels.cache.get(config.debug_channel);
        if (!ch) return console.log("[debug]", text);
        await ch.send("```" + String(text) + "```");
    } catch (e) {
        console.log("[debugDC error]", e.message);
    }
}

const { listAllCustomLobbies } = require("./clarion.js");
const { getLinkedIGNs } = require("./clarion.js");
const ign_map = require("./ign_map.json");

const sessions = new Map();              
const lastSessionForServer = new Map(); 
const staging = new Map();              

const WAIT_FOR_CODE_MS = config.wait_for_code_ms ?? 120000;
const WAIT_FOR_COUNT_MS = config.wait_for_count_ms ?? 10 * 60 * 1000; 
const POST_FULL_DELAY_MS = config.post_full_delay_ms ?? 7000; 
const INACTIVITY_MS = config.session_timeout_ms ?? 3600000; 


function getActiveSessionByCode(code) {
    if (!code) return null;
    return sessions.get(code) || null;
}

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

    await new Promise(res => setTimeout(res, 400)); // needed on slower machines so cache can be updated. ea like my raspberry pi  
    const allChannels = await relayGuild.channels.fetch();
    const existing = allChannels.find(c => c.name === name && c.parentId === categoryId);

    if (existing) {
    console.log(`[TEMP CHANNEL REUSE] Using existing channel ${existing.id} for code ${code}`);
    return { id: existing.id, reused: true };
    }

    let index = 1;
    while (relayGuild.channels.cache.find(c => c.name === name && c.parentId === categoryId)) {
        index += 1;
        name = `${base}-${safeCode}-${index}`.slice(0, 90);
        if (index > 50) break;
    }

    const opts = { type: ChannelType.GuildText, parent: categoryId, reason: `temp channel for code ${code}` };
    const ch = await relayGuild.channels.create({ name, ...opts });

    console.log(`[TEMP CHANNEL CREATED] ${ch.id} for code ${code}`);
    return { id: ch.id, reused: false };
}

async function sendPlainToChannel(channelId, text, components = []) {
    const ch = client.channels.cache.get(channelId);
    if (!ch) return;
    await ch.send({ content: text, allowedMentions: { roles: Object.values(config.relay_region_pings || {}) }, components }).catch(() => null);
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

function serverLabelMessagesForGuild(guildId) {
    const s = config.servers[guildId];
    if (!s) return [];
    if (s.invite) return [`[${s.name}]`, `<${s.invite}>`];
    return [`[${s.name}]`];
}

function buildSessionMessage(session, originCfg, countOrCurrent, expected = null, remaining = null) {
    const region = originCfg?.region;
    const relayRegionRoleId =
        region && config.relay_region_pings?.[region]
            ? config.relay_region_pings[region]
            : null;

    const roleMention =
        (!session.firstPingSent && relayRegionRoleId)
            ? `<@&${relayRegionRoleId}> `
            : "";

    const labels = serverLabelMessagesForGuild(originCfg?.guildId);
    const labelLine = labels.join(" ");

    let msg = `${roleMention}${session.firstPingSent ? labelLine + "\n" : ""}${session.code} | ${countOrCurrent}/6`;

    if (expected > 0) {
    msg += `\n-# ${expected} player${expected === 1 ? "" : "s"} are expected to join (soon).`;
    msg += `\n-# so, lobby needs ${remaining} more player${remaining === 1 ? "" : "s"} to be full.`;
    }

    if (!session.firstPingSent) {
        session.firstPingSent = true;
    }
    return msg;
}

const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function wordsToNum(w) { w = String(w).toLowerCase(); return WORD_NUM[w] ?? null; }

function extractPlayerCountFromText(text) {
    if (!text) return null;
    const raw = text.toLowerCase();

    // ignore questions
    if (raw.includes("?") || /\b(are\s+(you|u|we)|do\s+(you|u|we)|is\s+(it|the)|i\s+assume|assuming|maybe|might\s+be|could\s+be|if\s+(you|u)\s+don'?t\s+get|this\s+looks\s+like\s+we\s+need)\b/.test(raw) || (/\bor\b/.test(raw) && /\b(we got|we have|got|have)\b/.test(raw))) return null;
    const t = raw.replace(/[,!.?]/g, " ");

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
    m = t.match(/(?:needs|i need|we need|need)\s+(\d{1,2}|\w+)(?:\s*more)?\b/);
    if (m) { let raw = m[1]; let x = parseInt(raw, 10); if (isNaN(x)) x = wordsToNum(raw); if (x >= 0 && x <= 5) { if (x === 0) return null; const have = 6 - x; if (have >= 1 && have <= 6) return have; } }

    //treat +x as need x more => have = 6 - x
    m = t.match(/(?:\+|plus)\s*([0-9])/);
    if (m) { const x = parseInt(m[1], 10); if (x === 0) return null; if (x >= 1 && x <= 5) return 6 - x; }
    
    return null;
}


function extractCode(text) {
    if (!text) return null;
    const CODE_REGEX = /\b([A-Z][a-z]{3,10}){3}\b/; 
    const match = text.match(CODE_REGEX);
    return match ? match[0] : null;
}

async function updatePlayerCountForSession(session, count, originGuildId = null, rawText = "", authorId = null) {
    try {
        const originCfg = originGuildId ? config.servers[originGuildId] : null;
        let clarionHandled = false;
        session.lastActivity = now();

        let ignList = await getLinkedIGNs(session.ownerId);

        const speakerId = authorId ?? null;
        if (!ignList || ignList.length === 0) {
            ignList = await getLinkedIGNs(speakerId);
        }

        if (!ignList || ignList.length === 0) {
            ignList = ign_map?.[session.ownerId]
                || ign_map?.[speakerId]
                || null;
        }
        if (ignList && !Array.isArray(ignList)) {
            ignList = [ignList];
        }

        let ign = null;
        let match = null;

        if (ignList && ignList.length > 0) {
            const lobbies = await listAllCustomLobbies();
            
            match = lobbies.find(l =>
                ignList.some(i => i.toLowerCase() === l.ownerUsername?.toLowerCase())
            );

            if (match) {
                ign = match.ownerUsername;
            } else {
                ign = ignList[0];
            }
        }

        // clarion api validation
        let clarionCount = null;

        if (ign) {
            const lobbies = await listAllCustomLobbies();

            match = lobbies.find(
                l => l.ownerUsername?.toLowerCase() === ign.toLowerCase()
            );

            if (match) {
                clarionCount = match.numPlayers;
                const labels = serverLabelMessagesForGuild(originGuildId);
                session.apiActive = true;

                console.log("[CLARION LINKED]", {
                    session: session.code,
                    ign,
                    owner: match.ownerUsername,
                    players: `${match.numPlayers}/${match.lobbySize}`
                });
            } else {
                debugDC(
                    "[CLARION VALIDATION] no lobby owned by author; falling back to message-based counts",
                    { ign }
                );
            }
        }

        count = Math.max(1, Math.min(6, Number(count) || 1));

        if (clarionCount !== null && count >= clarionCount) {

            const current = clarionCount;
            const expected = Math.max(0, count - clarionCount);
            const totalIncoming = current + expected;
            const remaining = Math.max(0, 6 - totalIncoming);

            const newState = { current, expected, remaining };

            if (
                session.lastClarionState &&
                session.lastClarionState.current === newState.current &&
                session.lastClarionState.expected === newState.expected &&
                session.lastClarionState.remaining === newState.remaining
            ) {
                debugDC(`duplicate clarion state prevented for ${session.code}: ${JSON.stringify(newState)}`);
                return;
            }
            const msg = buildSessionMessage(session, originCfg, current, expected, remaining);
            await sendPlainToChannel(session.tempChannelId, msg);

            session.lastClarionState = newState;
            session.lastPlayers = current;
            clarionHandled = true;
        }

        const debugLines = [
            "PLAYER COUNT UPDATE DEBUG",
            "========================================",
            "",

            "IDs",
            "----------------------------------------",
            `session_id:              ${session.id}`,
            `session.lastActivity:    ${session.lastActivity}`,
            `session.tempChannelId:   ${session.tempChannelId}`,
            "",
            `originGuildId:           ${originGuildId}`,
            `origin_channel:          ${session.originChannelId || "unknown"}`,
            `configured_count_channel:${config.servers[originGuildId]?.count_channel || "none"}`,
            `relay_region_role:       ${config.relay_region_pings?.[config.servers[originGuildId]?.region] || "none"}`,
            "",
            `session_ownerId:         ${session.ownerId}`,
            `session_authorId:        ${session.authorId}`,
            "",

            "MESSAGE CONTEXT",
            "----------------------------------------",
            `session_code:            ${session.code}`,
            `raw_text:                "${rawText}"`,
            `parsed_count:            ${count}`,
            `origin_server_name:      ${config.servers[originGuildId]?.name || "unknown"}`,
            `origin_region:           ${config.servers[originGuildId]?.region || "unknown"}`,
            ""
        ];
        if (session.apiActive) {
            debugLines.push(
                "CLARION IGN / AUTHOR MAPPING",
                "----------------------------------------",
                `clarion_active:          ${session.apiActive}`,
                "",
                `ign_list:                ${JSON.stringify(ignList)}`,
                `selected_ign:            ${ign || "none"}`,
                `clarion_lobby_owner:     ${match?.ownerUsername || "none"}`,
                "",

                "CLARION COUNTS",
                "----------------------------------------",
                `clarion_count:           ${clarionCount !== null ? clarionCount : "n/a"}`,
                `clarion_lobby_players:   ${match ? `${match.numPlayers}/${match.lobbySize}` : "n/a"}`,
                `lastClarionState:        ${JSON.stringify(session.lastClarionState)}`,
                ""
            );
        }
        debugLines.push("========================================");
        debugDC(debugLines.join("\n"));

        if (clarionHandled === true) {
            return;
        }

        if (session.lastPlayers === count) {
            debugDC(`duplicate player count prevented for ${session.code}: ${count}/6`);
            return;
        }
        session.lastPlayers = count;

        let formatted = "";

        const msg = buildSessionMessage(session, originCfg, count);
        await sendPlainToChannel(session.tempChannelId, msg);

        if (session.tempChannelId) {
            await sendPlainToChannel(session.tempChannelId, formatted).catch(() => null);
        }
        if (count >= 6) {
            await sendPlainToChannel(session.tempChannelId, `full (6/6)`).catch(() => null);
            setTimeout(() => endSession(session, "session ended (full)"), POST_FULL_DELAY_MS);
        }
    } catch (e) {
        console.log("updatePlayerCountForSession ERROR:", e);
    }
}

async function createSessionFromStaging(guildId) {
    const s = staging.get(guildId);
    if (!s || !s.code) return null;

    // no dups for the same code
    const existing = getActiveSessionByCode(s.code);
    if (existing) {
        clearStaging(guildId);

        // auto-update the existing session if a new count arrives
        if (s.have !== null) {
            await updatePlayerCountForSession(existing, s.have, guildId, s.rawText, s.authorId);
        }
        return null;
    }

    if (!s.pingSeen || !s.code || s.have === null) return null;

    const code = s.code;
    const { id: tempId, reused } = await createTempChannel(code).catch(err => { debugDC(`createTempChannel err ${err.message}`); return { id: null, reused: false }; });
    if (!tempId) return null;

    let session = sessions.get(code);

    if (!session) {
        session = {
            code,
            id: crypto.randomUUID(),
            servers: new Set(),
            ggsSenders: new Set(),
            firstPingSent: false,
            lastClarionState: null,
        };
        sessions.set(code, session);
    }
    if (reused) {
        session.firstPingSent = true;
    }

    // session state
    session.apiActive ??= false;
    lastSessionForServer.set(guildId, code);

    session.tempChannelId = tempId;
    session.originChannelId = s.originChannelId;
    session.createdAt ??= now();
    session.lastActivity = now();
    session.timeout = null;
    session.originalCodeMsgId = null;
    session.lastPlayers = null;
    session.ownerId = s.ownerId ?? s.authorId ?? null;
    session.authorId = s.authorId;


    // send server + links, intro and delete button
    if (!reused) {
        const labels = serverLabelMessagesForGuild(guildId);
        const labelLine = labels.join(" ");

        await sendPlainToChannel(tempId, labelLine);
        await sendPlainToChannel(
            tempId,
            "If the custom game lobby has reached its full six players, then this channel has served its purpose. Close it to maintain order."
        );
        await sendPlainToChannel(tempId, null, drekarDeleteButtonRow());
    }
    if (s.have !== null) {
        await updatePlayerCountForSession(session, s.have, guildId, s.rawText || "", s.authorId);
    }

    session.timeout = setTimeout(() => endSession(session, "session ended (inactive)"), INACTIVITY_MS);

    clearStaging(guildId);

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

client.on("messageCreate", async (msg) => {
    try {
        if (msg.author.bot) return;
        if (!msg.guild) return;
        if (!config.servers[msg.guild.id]) return;

        const guildId = msg.guild.id;
        const serverCfg = config.servers[guildId];
        const raw = msg.content ? msg.content.trim() : "";

        // handle full decection in temp channels
        for (const session of sessions.values()) {
            if (session.tempChannelId === msg.channel.id) {
                const parsed = extractPlayerCountFromText(raw);

                if (parsed === 6) {
                    await sendPlainToChannel(session.tempChannelId, `confirmed, full (6/6) \n-# closing channel in ${POST_FULL_DELAY_MS / 1000} seconds`).catch(() => null);
                    setTimeout(() => endSession(session, "session ended (full)"), POST_FULL_DELAY_MS);
                }
                return;
            }
        }

        // filter out messages from the wrong channels
        if (serverCfg.count_channel) {
            if (msg.channel.id !== serverCfg.count_channel) {
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

        const hasRolePing = msg.mentions.roles.has(serverCfg.ping_role) || raw.includes(`<@&${serverCfg.ping_role}>`) || raw.includes(`<@${serverCfg.ping_role}>`);
        const code = extractCode(raw);
        const have = extractPlayerCountFromText(raw);

        let s = staging.get(guildId);
        if (!s) {
            s = { code: null, have: null, pingSeen: false, timers: {}, createdAt: null, authorId: msg.author.id };
            staging.set(guildId, s);
        }
        s.originChannelId = msg.channel.id;
        s.authorId = msg.author.id;
        s.rawText = raw;

        if (hasRolePing) {
            s.pingSeen = true;
            s.createdAt = s.createdAt || now();
            s.ownerId = msg.author.id;

            if (!s.timers.pingCodeTimer) {
                s.timers.pingCodeTimer = setTimeout(() => {
                    clearStaging(guildId);
                }, WAIT_FOR_CODE_MS);
            }
        }

        if (code) {
            s.code = code;
            s.createdAt = s.createdAt || now();

            if (s.pingSeen) promoteToCountWait(guildId);
            else if (!s.timers.pingCodeTimer) {
                s.timers.pingCodeTimer = setTimeout(() => { debugDC(`ping+code wait expired for guild ${guildId}`); clearStaging(guildId); }, WAIT_FOR_CODE_MS);
            }
        }

        if (have !== null) {
            if (s.code && s.pingSeen) {
                s.have = have;
                await createSessionFromStaging(guildId);
                return;
            }
            s.have = have;
        }

        // if we have all three (ping,code, player-count) present -> create session
        if (s.code && s.pingSeen && s.have !== null) {
            await createSessionFromStaging(guildId);
            return;
        }

        if (hasRolePing && code) return;
        if ((!s.code && !s.pingSeen) && have !== null) {
            let target = null;
            if (sessions.size === 1) target = [...sessions.values()][0];
            else {
                const last = lastSessionForServer.get(guildId);
                if (last && sessions.has(last)) target = sessions.get(last);
            }

            if (target) {
                await updatePlayerCountForSession(target, have, guildId, raw, msg.author.id);
                if (have >= 6) {
                    await sendPlainToChannel(target.tempChannelId, `full (6/6)`).catch(() => null);
                    setTimeout(() => endSession(target, "session ended (full)"), POST_FULL_DELAY_MS);
                }
                return;
            }
        }

    } catch (e) {
        console.log("updatePlayerCountForSession ERROR:", e);
        console.log("STACK:", e.stack);
        debugDC(" updatePlayerCountForSession ERROR: " + (e.stack || e.message));
    }

});

async function endSession(session, reasonText, originGuildId = null) {
    try {
        if (session.tempChannelId) {
            const labels = serverLabelMessagesForGuild(originGuildId);
            for (const m of labels) await sendPlainToChannel(session.tempChannelId, m).catch(() => null);
            await sendPlainToChannel(session.tempChannelId, reasonText).catch(() => null);
            const ch = client.channels.cache.get(session.tempChannelId);
            if (ch && ch.deletable) await ch.delete().catch(() => null);
        }

    } catch (e) {
        debugDC("endSession error", e.message);
    } finally {
        if (session.timeout) clearTimeout(session.timeout);
        sessions.delete(session.code);
    }
}

setInterval(() => {
    const cutoff = now() - INACTIVITY_MS;
    for (const session of sessions.values()) {
        if (session.lastActivity < cutoff) {
            endSession(session, "session ended (inactive)").catch(() => null);
        }
    }
}, 30000);

client.on("clientReady", () => {
console.log(`logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
