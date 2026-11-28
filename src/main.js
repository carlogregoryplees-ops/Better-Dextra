import base from "./index.js";

const VERSIE = "2026-11-28-c";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Onthoudt (zolang de worker warm is) welk model werkt en welke denkinstelling geaccepteerd wordt.
const MEM = { good: null, noThink: new Set() };

function thinkCfg(m) {
  return m.startsWith("gemini-2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
}

async function call(env, m, prompt, think) {
  const gen = { temperature: 0.4, maxOutputTokens: 2500 };
  if (think) gen.thinkingConfig = thinkCfg(m);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gen }),
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "status " + r.status); e.status = r.status; throw e; }
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text) throw new Error("leeg antwoord");
  return text;
}

// Chat via Google Gemini (gratis niveau). Zonder GEMINI_API_KEY valt alles terug op index.js.
async function gemini(env, prompt) {
  if (typeof prompt !== "string" || !prompt || prompt.length > 60000) throw new Error("ongeldige vraag");
  const list = [MEM.good, env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash"].filter(Boolean);
  const models = [...new Set(list)];
  const errs = [];
  for (const m of models) {
    try {
      let text;
      if (!MEM.noThink.has(m)) {
        try { text = await call(env, m, prompt, true); }
        catch (e) {
          if (e.status === 400) { MEM.noThink.add(m); text = await call(env, m, prompt, false); }
          else throw e;
        }
      } else text = await call(env, m, prompt, false);
      MEM.good = m;
      return { text, model: m };
    } catch (e) { if (MEM.good === m) MEM.good = null; errs.push(m + ": " + String((e && e.message) || e).slice(0, 160)); }
  }
  throw new Error("Gemini faalde. " + errs.join(" | "));
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === "/api/status") {
      const r = await base.fetch(req, env, ctx);
      const j = await r.json();
      j.geminiKey = !!env.GEMINI_API_KEY;
      j.versie = VERSIE;
      j.model = MEM.good;
      return J(j);
    }
    if (env.GEMINI_API_KEY && u.pathname === "/api/chat" && req.method === "POST") {
      if (!env.DEXTRA_PIN) return J({ error: "DEXTRA_PIN ontbreekt in Cloudflare" }, 503);
      if (req.headers.get("x-pin") !== env.DEXTRA_PIN) return J({ error: "PIN onjuist" }, 401);
      try {
        const b = await req.json();
        const t0 = Date.now();
        const r = await gemini(env, b.prompt);
        return J({ text: r.text, model: r.model, ms: Date.now() - t0 });
      } catch (e) {
        return J({ error: String((e && e.message) || e) }, 502);
      }
    }
    return base.fetch(req, env, ctx);
  },
};
