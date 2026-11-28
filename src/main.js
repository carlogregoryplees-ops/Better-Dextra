import base from "./index.js";

const VERSIE = "2026-11-28-b";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Chat via Google Gemini (gratis niveau). Zonder GEMINI_API_KEY valt alles terug op index.js.
async function gemini(env, prompt) {
  if (typeof prompt !== "string" || !prompt || prompt.length > 60000) throw new Error("ongeldige vraag");
  const models = [env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"].filter(Boolean);
  const errs = [];
  for (const m of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 2500 } }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "status " + r.status);
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const text = parts.map((p) => p.text || "").join("");
      if (text) return text;
      throw new Error("leeg antwoord");
    } catch (e) { errs.push(m + ": " + String((e && e.message) || e).slice(0, 160)); }
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
      return J(j);
    }
    if (env.GEMINI_API_KEY && u.pathname === "/api/chat" && req.method === "POST") {
      if (!env.DEXTRA_PIN) return J({ error: "DEXTRA_PIN ontbreekt in Cloudflare" }, 503);
      if (req.headers.get("x-pin") !== env.DEXTRA_PIN) return J({ error: "PIN onjuist" }, 401);
      try {
        const b = await req.json();
        return J({ text: await gemini(env, b.prompt) });
      } catch (e) {
        return J({ error: String((e && e.message) || e) }, 502);
      }
    }
    return base.fetch(req, env, ctx);
  },
};
