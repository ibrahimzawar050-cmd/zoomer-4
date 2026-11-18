import type { Config } from "@netlify/functions";

type Result = { title: string; url: string; snippet: string };

const clean = (s: unknown) =>
  String(s ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": status === 200 ? "public, max-age=300" : "no-store" },
  });

// Tavily: free plan, 1,000 credits a month. Returns null when it can't answer
// (quota used up, bad key, error) so the caller can fall back to Marginalia.
async function tavily(q: string, page: number, key: string): Promise<Result[] | null> {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, max_results: page * 10, search_depth: "basic" }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const out = (d.results || []).slice((page - 1) * 10, page * 10).map((x: any) => ({
    title: clean(x.title), url: x.url, snippet: clean(x.content).slice(0, 300),
  }));
  return out.length ? out : null;
}

// Marginalia: free, no signup, shared rate limit on the "public" key.
async function marginalia(q: string, page: number): Promise<Result[]> {
  const key = Netlify.env.get("MARGINALIA_API_KEY") || "public";
  const r = await fetch(
    `https://api2.marginalia-search.com/search?query=${encodeURIComponent(q)}&count=${page * 10}`,
    { headers: { "API-Key": key, Accept: "application/json" } },
  );
  if (r.status === 429 || r.status === 503) throw new Error("busy");
  if (!r.ok) throw new Error("bad:" + r.status);
  const d = await r.json();
  return (d.results || []).slice((page - 1) * 10, page * 10).map((x: any) => ({
    title: clean(x.title), url: x.url, snippet: clean(x.description),
  }));
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
  const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), 10);
  if (!q) return json({ error: "Type something to search for." }, 400);

  const serper = Netlify.env.get("SERPER_API_KEY");
  const brave = Netlify.env.get("BRAVE_API_KEY");
  const searxng = Netlify.env.get("SEARXNG_URL");
  const tavilyKey = Netlify.env.get("TAVILY_API_KEY");

  try {
    let results: Result[] = [];

    if (serper) {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": serper, "Content-Type": "application/json" },
        body: JSON.stringify({ q, page, num: 10 }),
      });
      if (!r.ok) return json({ error: `Search service returned ${r.status}.` }, 502);
      const d = await r.json();
      results = (d.organic || []).map((x: any) => ({
        title: clean(x.title), url: x.link, snippet: clean(x.snippet),
      }));
    } else if (brave) {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&offset=${page - 1}`,
        { headers: { "X-Subscription-Token": brave, Accept: "application/json" } },
      );
      if (!r.ok) return json({ error: `Search service returned ${r.status}.` }, 502);
      const d = await r.json();
      results = (d.web?.results || []).map((x: any) => ({
        title: clean(x.title), url: x.url, snippet: clean(x.description),
      }));
    } else if (searxng) {
      const base = searxng.replace(/\/$/, "");
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json&pageno=${page}`);
      if (!r.ok) return json({ error: `Search service returned ${r.status}.` }, 502);
      const d = await r.json();
      results = (d.results || []).map((x: any) => ({
        title: clean(x.title), url: x.url, snippet: clean(x.content),
      }));
    } else {
      // Tavily first (pages 1-2 only, it returns at most 20 results), then Marginalia.
      const fromTavily = tavilyKey && page <= 2 ? await tavily(q, page, tavilyKey) : null;
      results = fromTavily ?? (await marginalia(q, page));
    }

    return json({ q, page, results: results.filter((x) => /^https?:\/\//.test(x.url)) });
  } catch (e) {
    if (e instanceof Error && e.message === "busy") {
      return json({ error: "Zoomer's free search is busy right now. Wait a few seconds and try again." }, 503);
    }
    return json({ error: "Couldn't reach the search service. Try again in a moment." }, 502);
  }
};

export const config: Config = { path: "/api/search" };
