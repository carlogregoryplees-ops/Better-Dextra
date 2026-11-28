const PL = { Mol: [51.19, 5.11], Geel: [51.16, 4.99], Hulshout: [51.06, 4.79] };
const FEEDS = [
  ["NOS Economie", "https://feeds.nos.nl/nosnieuwseconomie", false],
  ["VRT NWS", "https://www.vrt.be/vrtnws/nl.rss.articles.xml", true],
];
const ECO = /econom|beurs|inflatie|bedrijf|prijs|werkloos|rente|energie|faillisse|bank|loon|belasting|handel|markt|aandel|industrie|banen|btw/i;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = (s) => (s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

async function get(url, ttl = 300) {
  const r = await fetch(url, { headers: { "user-agent": "Better-Dextra/1.0" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(new URL(url).host + " gaf status " + r.status);
  return r;
}

function parseRss(xml, src) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].slice(0, 15).map((m) => {
    const g = (t) => { const x = m[0].match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">")); return x ? clean(x[1]) : ""; };
    return { title: g("title"), url: g("link"), summary: g("description").slice(0, 300), date: g("pubDate"), source: src };
  }).filter((i) => i.title && /^https:\/\//.test(i.url));
}

async function nieuws() {
  const res = await Promise.allSettled(FEEDS.map(async ([n, u, f]) => {
    const items = parseRss(await (await get(u)).text(), n);
    return f ? items.filter((i) => ECO.test(i.title + " " + i.summary)) : items;
  }));
  const items = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!items.length) throw new Error("geen artikels opgehaald: " + res.map((r) => r.reason && r.reason.message).filter(Boolean).join("; "));
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { items: items.slice(0, 12), bronnen: FEEDS.map((f, i) => ({ naam: f[0], ok: res[i].status === "fulfilled" })) };
}

async function weer() {
  const j = await (await get("https://data.buienradar.nl/2.0/feed/json")).json();
  const f = j.forecast;
  if (!f) throw new Error("Buienradar gaf een onverwacht formaat");
  const w = f.weatherreport || {};
  return { bron: "Buienradar", rapport: { title: clean(w.title), summary: clean(w.summary), text: clean(w.text) }, dagen: f.fivedayforecast || [] };
}

async function regen(place) {
  const p = PL[place];
  if (!p) throw new Error("onbekende plaats");
  const t = await (await get(`https://gpsgadget.buienradar.nl/data/raintext?lat=${p[0]}&lon=${p[1]}`, 120)).text();
  const data = t.trim().split(/\r?\n/).map((l) => {
    const [v, tm] = l.split("|"); const n = parseInt(v, 10);
    return { time: (tm || "").trim(), mmh: n > 0 ? +Math.pow(10, (n - 109) / 32).toFixed(2) : 0 };
  }).filter((x) => /^\d\d:\d\d$/.test(x.time));
  if (!data.length) throw new Error("geen regendata ontvangen");
  return { bron: "Buienradar", place, data };
}

// Standaard gratis via Cloudflare Workers AI. Met een ANTHROPIC_API_KEY (betaald) gebruikt hij Claude.
async function chat(env, prompt) {
  if (typeof prompt !== "string" || !prompt || prompt.length > 40000) throw new Error("ongeldige vraag");
  if (env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "Claude API status " + r.status);
    return j.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  if (!env.AI) throw new Error("geen AI gekoppeld (binding AI ontbreekt)");
  const models = [env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
  let last;
  for (const m of models) {
    try {
      const r = await env.AI.run(m, { messages: [{ role: "user", content: prompt }], max_tokens: 900 });
      let t = typeof r === "string" ? r : r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content));
      if (t) return typeof t === "string" ? t : JSON.stringify(t);
    } catch (e) { last = e; }
  }
  throw new Error("Workers AI: " + ((last && last.message) || "geen antwoord"));
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (u.pathname === "/api/status") return J({ pin: !!env.DEXTRA_PIN, ai: !!env.AI, claudeKey: !!env.ANTHROPIC_API_KEY, kv: !!env.STATE });
      if (!env.DEXTRA_PIN) return J({ error: "DEXTRA_PIN ontbreekt in Cloudflare" }, 503);
      if (req.headers.get("x-pin") !== env.DEXTRA_PIN) return J({ error: "PIN onjuist" }, 401);
      switch (u.pathname) {
        case "/api/weer": return J(await weer());
        case "/api/regen": return J(await regen(u.searchParams.get("place") || "Mol"));
        case "/api/nieuws": return J(await nieuws());
        case "/api/chat": { const b = await req.json(); return J({ text: await chat(env, b.prompt) }); }
        case "/api/state": {
          if (!env.STATE) return J({ state: null, kv: false });
          if (req.method === "PUT") {
            const t = await req.text();
            if (t.length > 200000) return J({ error: "te groot" }, 413);
            await env.STATE.put("state", t);
            return J({ ok: true });
          }
          const s = await env.STATE.get("state");
          return J({ state: s ? JSON.parse(s) : null, kv: true });
        }
      }
      return J({ error: "onbekend adres" }, 404);
    } catch (e) {
      return J({ error: String((e && e.message) || e) }, 502);
    }
  },
};
