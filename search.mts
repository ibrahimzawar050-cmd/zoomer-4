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

async function handleSearch(req: Request) {
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
}

// ---- Opening pages inside Zoomer ----
// Refuse local and private addresses so this can't be used to reach internal services.
function blocked(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(localhost|local|internal)$/.test(h)) return true;
  if (h.includes(":")) return /^(::1?$|::ffff|f[cd]|fe80)/.test(h);
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !h.includes(".");
}

async function get(u: URL) {
  for (let i = 0; i < 4; i++) {
    if (!/^https?:$/.test(u.protocol) || blocked(u.hostname)) throw new Error("blocked");
    const r = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZoomerBot/1.0)", Accept: "text/html,*/*;q=0.8" },
    });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u); continue; }
    return r;
  }
  throw new Error("redirects");
}

// A site can be shown in a frame unless it forbids it with X-Frame-Options or CSP frame-ancestors.
function embeddable(h: Headers) {
  if (h.get("x-frame-options")) return false;
  const m = (h.get("content-security-policy") || "").match(/frame-ancestors([^;]*)/i);
  return !(m && !m[1].includes("*"));
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function readable(html: string): string[] {
  const body = html
    .replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decode(body).split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 30).slice(0, 60);
}

async function handlePage(req: Request) {
  let u: URL;
  try { u = new URL(new URL(req.url).searchParams.get("url") || ""); }
  catch { return json({ error: "That doesn't look like a web address." }, 400); }

  try {
    const r = await get(u);
    const ok = embeddable(r.headers);
    let title = "";
    let text: string[] = [];
    if (/html/i.test(r.headers.get("content-type") || "")) {
      const html = (await r.text()).slice(0, 1_500_000);
      title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!ok) text = readable(html);
    }
    return json({ embeddable: ok, title, text });
  } catch (e) {
    const blockedMsg = e instanceof Error && e.message === "blocked";
    return json({ error: blockedMsg ? "Zoomer can't open that address." : "Couldn't reach that site." }, 502);
  }
}

// ---- The Zoomer page itself ----
const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zoomer</title>
<style>
  :root { --bg:#eef3f7; --bar:#dce6ee; --ink:#14212b; --muted:#55667a; --line:#c3d2de; --accent:#0b5fff; --card:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e151c; --bar:#18232d; --ink:#e8eff5; --muted:#92a4b6; --line:#2a3846; --accent:#6ea2ff; --card:#151f29; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  button { font: inherit; cursor: pointer; color: inherit; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  #tabs { display: flex; align-items: flex-end; gap: 2px; padding: 8px 8px 0; background: var(--bar); overflow-x: auto; }
  .tab { display: flex; align-items: center; flex: 0 0 auto; width: 170px; border-radius: 10px 10px 0 0; }
  .tab.on { background: var(--bg); }
  .tab .t { flex: 1; min-width: 0; padding: 8px 4px 8px 12px; border: 0; background: none; font-size: .85rem; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab .x, #add { border: 0; background: none; color: var(--muted); border-radius: 50%; width: 26px; height: 26px; line-height: 1; }
  .tab .x { margin-right: 4px; }
  #add { margin: 0 0 5px 4px; flex: 0 0 auto; font-size: 1.2rem; }
  .tab .x:hover, #add:hover { background: var(--line); }
  #bar { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  #bar button { border: 0; border-radius: 999px; background: var(--bar); width: 38px; height: 38px; font-size: 1.1rem; }
  #url { flex: 1; min-width: 0; font: inherit; padding: 8px 16px; border: 2px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); }
  #panes { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; overflow: auto; }
  .pane[hidden] { display: none; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .col { max-width: 720px; margin: 0 auto; padding: 12px 20px 60px; }
  .home { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 24px 12vh; }
  .logo { position: relative; font-size: clamp(2.6rem, 9vw, 4.2rem); font-weight: 900; font-style: italic; letter-spacing: -0.04em; }
  .logo::before, .logo::after { content: ""; position: absolute; left: -26px; height: 4px; background: var(--accent); border-radius: 2px; }
  .logo::before { top: 42%; width: 20px; } .logo::after { top: 62%; width: 12px; opacity: .6; }
  .home form { display: flex; gap: 10px; margin-top: 22px; width: min(560px, 100%); }
  .home input { flex: 1; min-width: 0; font: inherit; padding: 14px 18px; border: 2px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); }
  .home form button { font-weight: 700; padding: 0 24px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; }
  @media (prefers-color-scheme: dark) { .home form button { color: #0e151c; } }
  .result { padding: 16px 0; border-bottom: 1px solid var(--line); }
  .result .site { color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .result h2 { margin: 2px 0 4px; font-size: 1.2rem; line-height: 1.3; }
  .result a { color: var(--accent); text-decoration: none; } .result a:hover { text-decoration: underline; }
  .result p { margin: 0; color: var(--muted); max-width: 65ch; }
  .msg { color: var(--muted); padding: 24px 0; }
  .msg.error { color: var(--ink); border-left: 4px solid var(--accent); padding-left: 14px; }
  .pager { display: flex; justify-content: space-between; padding-top: 20px; }
  .pager button { background: var(--card); border: 2px solid var(--line); border-radius: 999px; padding: 10px 20px; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .note { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); padding: 12px 14px; border-radius: 8px; color: var(--muted); font-size: .9rem; margin-top: 12px; }
  .note a { color: var(--accent); }
  .col h1 { font-size: 1.5rem; line-height: 1.25; }
  .read { max-width: 65ch; }
</style>
</head>
<body>
<div id="tabs" role="tablist" aria-label="Tabs"></div>
<form id="bar">
  <button type="button" id="reload" aria-label="Reload" title="Reload">&#8635;</button>
  <input id="url" type="text" placeholder="Search or type a web address" aria-label="Search or type a web address" autocomplete="off" spellcheck="false">
</form>
<div id="panes"></div>
<script>
const tabsEl = document.getElementById("tabs"), urlEl = document.getElementById("url"), panes = document.getElementById("panes");
let tabs = [], cur = null, uid = 0;

const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const msg = (x, c = "") => el("p", "msg " + c, x);
const col = (...n) => { const d = el("div", "col"); d.append(...n); return d; };
const addBtn = el("button", "", "+");
addBtn.id = "add"; addBtn.type = "button"; addBtn.title = "New tab"; addBtn.setAttribute("aria-label", "New tab");
addBtn.onclick = () => newTab();

function newTab() {
  if (tabs.length >= 12) return cur;
  const t = { kind: "home", title: "New tab", url: "", query: "", page: 1, seq: 0, pane: el("section", "pane") };
  tabs.push(t); panes.append(t.pane); home(t); pick(t); return t;
}
function pick(t) {
  cur = t; tabs.forEach(x => x.pane.hidden = x !== t); sync();
  if (t.kind === "home") urlEl.focus();
}
function closeTab(t) {
  const i = tabs.indexOf(t); tabs.splice(i, 1); t.pane.remove(); t.seq++;
  if (!tabs.length) return newTab();
  if (cur === t) pick(tabs[Math.min(i, tabs.length - 1)]); else sync();
}
function sync() {
  tabsEl.replaceChildren(...tabs.map(t => {
    const d = el("div", "tab" + (t === cur ? " on" : "")), b = el("button", "t", t.title), x = el("button", "x", "\u00d7");
    b.type = x.type = "button"; b.title = t.title; x.setAttribute("aria-label", "Close tab " + t.title);
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", t === cur);
    b.onclick = () => pick(t); x.onclick = () => closeTab(t); d.append(b, x); return d;
  }), addBtn);
  urlEl.value = cur.kind === "page" ? cur.url : cur.kind === "results" ? cur.query : "";
  document.title = cur.kind === "home" ? "Zoomer" : cur.title + " \u2013 Zoomer";
}

function home(t) {
  t.kind = "home"; t.title = "New tab"; t.url = t.query = "";
  const w = el("div", "home"), f = el("form"), i = el("input"), b = el("button", "", "Search");
  i.type = "search"; i.placeholder = "Search or type a web address"; i.setAttribute("aria-label", "Search or type a web address");
  b.type = "submit";
  f.onsubmit = e => { e.preventDefault(); go(t, i.value); };
  f.append(i, b); w.append(el("div", "logo", "Zoomer"), f); t.pane.replaceChildren(w);
}

function go(t, text) {
  text = text.trim(); if (!text) return;
  if (/^https?:\/\//i.test(text)) view(t, text);
  else if (/^[^\s\/]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) view(t, "https://" + text);
  else results(t, text, 1);
}

async function results(t, q, page) {
  t.kind = "results"; t.query = q; t.page = page; t.title = q; const n = ++t.seq; sync();
  t.pane.replaceChildren(col(msg("Searching\u2026")));
  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q) + "&page=" + page), d = await r.json();
    if (n !== t.seq) return;
    if (!r.ok) { t.pane.replaceChildren(col(msg(d.error || "Something went wrong.", "error"))); return; }
    if (!d.results.length) { t.pane.replaceChildren(col(msg("No results for \u201c" + q + "\u201d. Try different words."))); return; }
    const items = d.results.map(x => {
      const box = el("article", "result"), h = el("h2"), a = el("a", "", x.title || x.url);
      let host = x.url; try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch {}
      a.href = x.url; a.onclick = e => { e.preventDefault(); view(t, x.url); };
      h.append(a); box.append(el("div", "site", host), h, el("p", "", x.snippet)); return box;
    });
    const pg = el("div", "pager"), pv = el("button", "", "Previous"), nx = el("button", "", "Next");
    pv.type = nx.type = "button"; pv.disabled = page <= 1;
    pv.onclick = () => results(t, q, page - 1); nx.onclick = () => results(t, q, page + 1);
    pg.append(pv, nx); t.pane.replaceChildren(col(...items, pg)); t.pane.scrollTop = 0;
  } catch {
    if (n === t.seq) t.pane.replaceChildren(col(msg("Couldn\u2019t reach Zoomer\u2019s search. Check your connection and try again.", "error")));
  }
}

async function view(t, raw) {
  let u;
  try { u = new URL(raw); if (u.protocol === "http:") u.protocol = "https:"; }
  catch { t.pane.replaceChildren(col(msg("That doesn\u2019t look like a web address.", "error"))); return; }
  const host = u.hostname.replace(/^www\./, "");
  t.kind = "page"; t.url = u.href; t.title = host; const n = ++t.seq; sync();
  t.pane.replaceChildren(col(msg("Opening " + host + "\u2026")));
  try {
    const r = await fetch("/api/page?url=" + encodeURIComponent(u.href)), d = await r.json();
    if (n !== t.seq) return;
    if (!r.ok) { t.pane.replaceChildren(col(msg(d.error || "Couldn\u2019t open that page.", "error"))); return; }
    if (d.title) t.title = d.title;
    if (d.embeddable) {
      const f = el("iframe"); f.title = t.title; f.src = u.href;
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      t.pane.replaceChildren(f);
    } else {
      const a = el("a", "", "Open the original site in a new browser tab");
      a.href = u.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      const note = el("div", "note");
      note.append("This site doesn\u2019t allow being shown inside Zoomer, so here is a text version. ", a, ".");
      const body = d.text.length ? d.text.map(x => el("p", "read", x)) : [msg("No readable text found on this page.")];
      t.pane.replaceChildren(col(note, el("h1", "", t.title), ...body)); t.pane.scrollTop = 0;
    }
    sync();
  } catch {
    if (n === t.seq) t.pane.replaceChildren(col(msg("Couldn\u2019t reach that site. Check the address and try again.", "error")));
  }
}

document.getElementById("bar").onsubmit = e => { e.preventDefault(); go(cur, urlEl.value); };
document.getElementById("reload").onclick = () => {
  if (cur.kind === "results") results(cur, cur.query, cur.page);
  else if (cur.kind === "page") view(cur, cur.url);
};

const first = newTab(), q0 = new URLSearchParams(location.search).get("q");
if (q0) go(first, q0);
</script>
</body>
</html>
`;

export default async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/search") return handleSearch(req);
  if (path === "/api/page") return handlePage(req);
  return new Response(HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
};

export const config: Config = { path: ["/", "/api/search", "/api/page"] };
