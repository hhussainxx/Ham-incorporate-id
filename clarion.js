const fetch = require("node-fetch");
const CLARION_URL = "https://api.clarioncorp.net/v2/customs/browse";

async function listAllCustomLobbies() {
  if (!process.env.CC_TOKEN) {
    console.log("[CLARION] no CC_TOKEN set");
    return [];
  }

  try {
    const res = await fetch(CLARION_URL, {
      headers: {
        Authorization: `Bearer ${process.env.CC_TOKEN}`,
        "accept-encoding": "identity",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      console.log("[CLARION] api error", res.status);
      return [];
    }

    const data = await res.json();
    return data.lobbies || [];
  } catch (err) {
    console.log("[CLARION] fetch failed", err.message);
    return [];
  }
}
module.exports = { listAllCustomLobbies };
