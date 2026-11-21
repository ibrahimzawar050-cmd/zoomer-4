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

// ---- AI Mode, Images, Videos and Short Videos ----
async function tavilySearch(body: Record<string, unknown>) {
  const key = Netlify.env.get("TAVILY_API_KEY");
  if (!key) throw new Error("nokey");
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ search_depth: "basic", ...body }),
  });
  if (!r.ok) throw new Error("tavily:" + r.status);
  return r.json();
}

const tavilyItems = (d: any): Result[] =>
  (d.results || []).map((x: any) => ({ title: clean(x.title), url: x.url, snippet: clean(x.content).slice(0, 200) }));

async function handleMedia(req: Request) {
  const p = new URL(req.url).searchParams;
  const type = p.get("type") || "";
  const q = (p.get("q") || "").trim().slice(0, 200);
  const page = Math.min(Math.max(parseInt(p.get("page") || "1", 10) || 1, 1), 10);
  if (!q) return json({ error: "Type something to search for." }, 400);

  try {
    if (type === "ai") {
      const d = await tavilySearch({ query: q, max_results: 6, include_answer: true });
      return json({ answer: clean(d.answer).replace(/\*\*|__/g, ""), items: tavilyItems(d) });
    }
    if (type === "videos") {
      const d = await tavilySearch({ query: q, max_results: 20, include_domains: ["youtube.com", "vimeo.com", "tiktok.com", "dailymotion.com"] });
      return json({ items: tavilyItems(d) });
    }
    if (type === "shorts") {
      const d = await tavilySearch({ query: q + " shorts", max_results: 20, include_domains: ["youtube.com", "tiktok.com"] });
      return json({ items: tavilyItems(d) });
    }
    if (type === "images") {
      const serper = Netlify.env.get("SERPER_API_KEY");
      if (serper) {
        const r = await fetch("https://google.serper.dev/images", {
          method: "POST",
          headers: { "X-API-KEY": serper, "Content-Type": "application/json" },
          body: JSON.stringify({ q, page }),
        });
        if (!r.ok) throw new Error("images:" + r.status);
        const d = await r.json();
        return json({ items: (d.images || []).map((x: any) => ({ thumb: x.thumbnailUrl, img: x.imageUrl, title: clean(x.title), page: x.link })) });
      }
      // Free default: Openverse (openly licensed images from Flickr, Wikimedia and others).
      const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20&page=${page}`, {
        headers: { Accept: "application/json" },
      });
      if (r.ok) {
        const d = await r.json();
        const items = (d.results || []).map((x: any) => ({ thumb: x.thumbnail, img: x.url, title: clean(x.title), page: x.foreign_landing_url || x.url }));
        if (items.length || page > 1) return json({ items });
      }
      // Fallback when Openverse is busy or empty: Tavily's image results (first page only).
      if (page === 1 && Netlify.env.get("TAVILY_API_KEY")) {
        const d = await tavilySearch({ query: q, max_results: 1, include_images: true, include_image_descriptions: true });
        const items = (d.images || []).map((x: any) =>
          typeof x === "string" ? { thumb: x, img: x, title: "", page: x } : { thumb: x.url, img: x.url, title: clean(x.description), page: x.url });
        return json({ items });
      }
      return json({ items: [] });
    }
    return json({ error: "Unknown tab." }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "nokey") return json({ error: "This tab needs your Tavily key. Add TAVILY_API_KEY in Netlify's environment variables, then redeploy." }, 503);
    if (m.startsWith("tavily:")) return json({ error: "This tab's free allowance may be used up for now. Try again later." }, 503);
    return json({ error: "Couldn't load this tab right now. Try again in a moment." }, 502);
  }
}

// ---- The Zoomer page itself ----
const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#7c5cff">
<link rel="icon" type="image/png" sizes="64x64" href="data:image/png;base64,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">
<link rel="apple-touch-icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAAMP2lDQ1BJQ0MgUHJvZmlsZQAAeJyVVwdYU8kWnluSkEBoAQSkhN4EkRpASggtgPQiiEpIAoQSY0JQsSOLCq5dLGBDV0UUO82O2FkEe18sqCjrYsGuvEkBXfeV753vm3v/+8+Z/5w5d24ZADROcESiPFQTgHxhgTguNJA+NiWVTnoOEKANtAAGbDhciYgZExMJoA2e/27vrkNvaFccZVr/7P+vpsXjS7gAIDEQZ/Ak3HyIDwKAV3FF4gIAiDLeYkqBSIZhAzpimCDEC2Q4S4GrZDhDgffKfRLiWBC3AqCixuGIswBQ74A8vZCbBTXU+yB2FvIEQgA06BD75edP4kGcDrEt9BFBLNNnZPygk/U3zYwhTQ4nawgr5iI3lSCBRJTHmfZ/luN/W36edDCGNWxq2eKwONmcYd1u5k6KkGE1iHuFGVHREGtD/EHAk/tDjFKypWGJCn/UiCthwZoBPYideZygCIiNIA4R5kVFKvmMTEEIG2K4QtCpggJ2AsT6EC/gS4LjlT6bxJPilLHQ+kwxi6nkz3HE8riyWPeluYlMpf7rbD5bqY+pF2UnJENMgdiyUJAUBbE6xE6S3PgIpc/oomxW1KCPWBony98S4ji+MDRQoY8VZopD4pT+ZfmSwflim7IF7Cgl3l+QnRCmqA/WyuXI84dzwTr4QmbioA5fMjZycC48flCwYu7YM74wMV6p80FUEBinGItTRHkxSn/cnJ8XKuPNIXaTFMYrx+JJBXBBKvTxTFFBTIIiT7wohxMeo8gHXwoiAQsEATqQwpYBJoEcIGjvbeiFV4qeEMABYpAF+MBRyQyOSJb3COExHhSBPyHiA8nQuEB5Lx8UQv7rEKs4OoJMeW+hfEQueAJxPogAefBaKh8lHIqWBB5DRvCP6BzYuDDfPNhk/f+eH2S/M0zIRCoZ6WBEusagJzGYGEQMI4YQ7XBD3A/3wSPhMQA2F5yBew3O47s/4Qmhk/CQcI3QRbg1UVAs/inLMaAL6ocoa5HxYy1wa6jpjgfivlAdKuN6uCFwxN1gHCbuDyO7Q5alzFtWFfpP2n+bwQ93Q+lHdiaj5GHkALLtzyPV7dXdh1Rktf6xPopcM4bqzRrq+Tk+64fq8+A54mdPbAF2ADuLncTOY0ewBkDHjmONWBt2VIaHVtdj+eoajBYnzycX6gj+EW/wzsoqKXGude5x/qLoK+BPlb2jAWuSaJpYkJVdQGfCLwKfzhZynUbQXZxdPACQfV8Ur683sfLvBqLX9p2b9wcAvscHBgYOf+fCjwOwzxM+/k3fOVsG/HSoAnCuiSsVFyo4XHYgwLeEBnzSDIAJsAC2cD4uwAP4gAAQDMJBNEgAKWACzD4brnMxmAJmgLmgFJSDpWAVWAc2gi1gB9gN9oMGcAScBGfARdABroE7cPV0gxegD7wDnxEEISFUhIYYIKaIFeKAuCAMxA8JRiKROCQFSUeyECEiRWYg85ByZDmyDtmM1CD7kCbkJHIe6URuIQ+QHuQ18gnFUDVUBzVGrdGRKANlohFoAjoezUIno0VoCboYXYNWo7vQevQkehG9hnahL9B+DGCqmB5mhjliDIyFRWOpWCYmxmZhZVgFVo3VYc3wPl/BurBe7CNOxGk4HXeEKzgMT8S5+GR8Fr4IX4fvwOvxVvwK/gDvw78RqAQjggPBm8AmjCVkEaYQSgkVhG2EQ4TT8FnqJrwjEol6RBuiJ3wWU4g5xOnERcT1xD3EE8RO4iNiP4lEMiA5kHxJ0SQOqYBUSlpL2kU6TrpM6iZ9UFFVMVVxUQlRSVURqhSrVKjsVDmmclnlqcpnsibZiuxNjibzyNPIS8hbyc3kS+Ru8meKFsWG4ktJoORQ5lLWUOoopyl3KW9UVVXNVb1UY1UFqnNU16juVT2n+kD1o5q2mr0aSy1NTaq2WG272gm1W2pvqFSqNTWAmkotoC6m1lBPUe9TP6jT1J3U2eo89dnqler16pfVX2qQNaw0mBoTNIo0KjQOaFzS6NUka1prsjQ5mrM0KzWbNG9o9mvRtEZpRWvlay3S2ql1XuuZNknbWjtYm6ddor1F+5T2IxpGs6CxaFzaPNpW2mlatw5Rx0aHrZOjU66zW6ddp09XW9dNN0l3qm6l7lHdLj1Mz1qPrZent0Rvv951vU/DjIcxh/GHLRxWN+zysPf6w/UD9Pn6Zfp79K/pfzKgGwQb5BosM2gwuGeIG9obxhpOMdxgeNqwd7jOcJ/h3OFlw/cPv22EGtkbxRlNN9pi1GbUb2xiHGosMl5rfMq410TPJMAkx2SlyTGTHlOaqZ+pwHSl6XHT53RdOpOeR19Db6X3mRmZhZlJzTabtZt9NrcxTzQvNt9jfs+CYsGwyLRYadFi0WdpajnGcoZlreVtK7IVwyrbarXVWav31jbWydbzrRusn9no27Btimxqbe7aUm39bSfbVttetSPaMexy7dbbddij9u722faV9pccUAcPB4HDeofOEYQRXiOEI6pH3HBUc2Q6FjrWOj5w0nOKdCp2anB6OdJyZOrIZSPPjvzm7O6c57zV+c4o7VHho4pHNY967WLvwnWpdLnqSnUNcZ3t2uj6ys3Bje+2we2mO819jPt89xb3rx6eHmKPOo8eT0vPdM8qzxsMHUYMYxHjnBfBK9BrttcRr4/eHt4F3vu9//Jx9Mn12enzbLTNaP7oraMf+Zr7cnw3+3b50f3S/Tb5dfmb+XP8q/0fBlgE8AK2BTxl2jFzmLuYLwOdA8WBhwLfs7xZM1kngrCg0KCyoPZg7eDE4HXB90PMQ7JCakP6Qt1Dp4eeCCOERYQtC7vBNmZz2TXsvnDP8JnhrRFqEfER6yIeRtpHiiObx6BjwsesGHM3yipKGNUQDaLZ0Sui78XYxEyOORxLjI2JrYx9Ejcqbkbc2Xha/MT4nfHvEgITliTcSbRNlCa2JGkkpSXVJL1PDkpentw1duTYmWMvphimCFIaU0mpSanbUvvHBY9bNa47zT2tNO36eJvxU8efn2A4IW/C0YkaEzkTD6QT0pPTd6Z/4URzqjn9GeyMqow+Lou7mvuCF8Bbyevh+/KX859m+mYuz3yW5Zu1Iqsn2z+7IrtXwBKsE7zKCcvZmPM+Nzp3e+5AXnLennyV/PT8JqG2MFfYOslk0tRJnSIHUamoa7L35FWT+8QR4m0SRDJe0ligA3/k26S20l+kDwr9CisLP0xJmnJgqtZU4dS2afbTFk57WhRS9Nt0fDp3essMsxlzZzyYyZy5eRYyK2NWy2yL2SWzu+eEztkxlzI3d+7vxc7Fy4vfzkue11xiXDKn5NEvob/UlqqXiktvzPeZv3EBvkCwoH2h68K1C7+V8coulDuXV5R/WcRddOHXUb+u+XVgcebi9iUeSzYsJS4VLr2+zH/ZjuVay4uWP1oxZkX9SvrKspVvV01cdb7CrWLjaspq6equNZFrGtdarl269su67HXXKgMr91QZVS2ser+et/7yhoANdRuNN5Zv/LRJsOnm5tDN9dXW1RVbiFsKtzzZmrT17G+M32q2GW4r3/Z1u3B71464Ha01njU1O412LqlFa6W1PbvSdnXsDtrdWOdYt3mP3p7yvWCvdO/zfen7ru+P2N9ygHGg7qDVwapDtENl9Uj9tPq+huyGrsaUxs6m8KaWZp/mQ4edDm8/Ynak8qju0SXHKMdKjg0cLzref0J0ovdk1slHLRNb7pwae+pqa2xr++mI0+fOhJw5dZZ59vg533NHznufb7rAuNBw0eNifZt726Hf3X8/1O7RXn/J81Jjh1dHc+fozmOX/S+fvBJ05cxV9tWL16KudV5PvH7zRtqNrpu8m89u5d16dbvw9uc7c+4S7pbd07xXcd/ofvUfdn/s6fLoOvog6EHbw/iHdx5xH714LHn8pbvkCfVJxVPTpzXPXJ4d6Qnp6Xg+7nn3C9GLz72lf2r9WfXS9uXBvwL+ausb29f9Svxq4PWiNwZvtr91e9vSH9N//13+u8/vyz4YfNjxkfHx7KfkT08/T/lC+rLmq93X5m8R3+4O5A8MiDhijvxXAIMNzcwE4PV2AKgpANDg/owyTrH/kxui2LPKEfhPWLFHlBv8c6mD/++xvfDv5gYAe7fC7RfU10gDIIYKQIIXQF1dh9rgXk2+r5QZEe4DNsV9zcjPAP/GFHvOH/L++Qxkqm7g5/O/AIIRfGDy/n80AAAASFBMVEX///////3+//7+/v39+/2unMA9FHM+Dnw8DXo8Dnc6DXc6DXQ9C3w8DHo7DHo6DHc5DnU5DXU4DXU5DnM5DXI3DXE5DHQzCWwrWWoNAAAbvklEQVR42s1djWLavA4N0EJiNyQmCX3/N73SOZLtUOiSb3frvJYBpeWgyNLRj+1meTLmaZon3uDrxaNJH8UYp/IzeTTKmPDfhB/pvRjtV8sr/dFtHFOcYhox5Mnl16N5CnoGphkIcWsIq0fyvcwR7zz5z+UmTiNACo4RH0jh6x38OYyp3MjtmJK+KiWBnZK+638FLX9N/pLeFTyj/Js6uR27DpimiWKRxxhyR+5OUe9O1ZMc564M3scF6KK+hq+SxyrplG6VUHhRNoKeqR3RLuDy+TfGogIZIS5HzMsBOLxCC25egFbZijDkr+Dvnf/KAPLzNJtamibOJvmpfJYX6sHXjIvifX9/f3scDcbb25MfvO0YzervyBsp8iXOPknnFeo5f57noOdZxDwq4vyXT6txlJEfvK1/hJsDh75K/9ffqF9xLE/w9QZfcKui6MTVGT1lnfD5SwPwfCLOsVs+398phy9wtwz5zafPy5+wHzVrcaiwT4pbYHewPmZuIMQi8nl+BXrpPs8CWYR4bA72x4+484Dh8Ar0y4/nH73JI78BgAO2WBbYAZt3Kz35CtoMzPR5flPIzdexTdCvL4pfsCd/mvI+CezPsaNyTCvQ5gmmGrRpvGiUYhYpPwP9KJ/X4/Q4fvkbB7xKptH7ZzQnaj7OjZ35vAJaPwd87/T5+d68bXqbb0HLh17Nhs2/eBLU5zEWz7sCreJu3MpB+wWzKIdibn4X9H8eB6AWFjKnKdtognbbZ6Dn7K/F1rnJ+BnMh0Z0RGbjPIpTF0SzybriRI3PQHoUGRD08cdAw9CKqJfldpPLrnLM1M+1vKHjBmKlaB0F7Sb1Z4aYkfPnKKBnXn3nTW5CKtBqOMYzZ+HPgj6qqCeohqEuktbnGrsfKeoO07C46R+biyJqquxIj+7RBwTcZFoXQZsXtdE/DVrco5q9ieoRIdHMsRU0ZuiEWEPU42yOxVH/5FRksMAwaCrBlKoHMUPu8pk60Q64YHF5x+b4V0zc4Yl7Vas3E7XLGJbZdHpagdZ5CNpw+Ht2+RXoz8xAIGh6xNlBjxOj1omgRaWf/qG/Cbo5AXQO9CnpxR41Ux6Kncbj8A+AplJnPjpZQIBHzUhTODLEoj9s/iLob8xHp9eeE7BkKmaT9Ohyng20Rkk/Cxrm49KNU0m/MLdCjzh6JkNgL0v4t0CHMZO8EpcraMVM3EIGxeQp9diqHn9CjRhBnijpseS6snJPCtp0WnFH5Uunt80m74+BPpqkY0kdFlc+GWi/UdAH9YiH35j5/z9Jh5hK7qYkcRpohk1GCV0YtzyCfoXuz2i+Yj6Inb60ISSR5DzmxCVVBM5lNOMxxbEzlnf48yL9llHDI4YQRuSA1yxvaSZOQ8hbHBCU+vTjoBG7jAp61BzwmuUtjfP/EYJ+FLWB/Yr58YnyikPz7Qf81cdnRk1BjymITidF7SpNtTbQzJ4xWWyiJjV9qcwvQR++vyq/umbEjHiru2nKXfPWbq3HG2S7NDAoTN1HJLjPnvb4b6Cb/wdoMbvn5Y4YUUU9mqBHxo06EaksKmpk8DsoyNtPgj6pdoT7XXAqZFQ1FLQI+qZkozFSGq3a0LZddyPqvbHtYdPLfzmhkSFW7YC9MP2AZo9Jw6wx3Rpz6NQNjssizpzC3uUU6pf/96BHQes0NAsBwFbjUa3QilJj9CkWQcvX8nl+f2N2enMG7vQl+fhfQUPQowJLkDILX/I9Uclvoh5pdtAtRhDy3X0StirZaffIJQqUBbbyFFd359Iz0I4se91ucsO6mkhaPol+pJAFLUP9kJZcWHD5zcikWPwNFlpvkakRI0zXgn+CGTpyG29qTQQ0EpTBFRomHbYxLl7aev+N8dacNjpVvuIEc3fpBEMIXYCCRIUL7PwUDQzKLAqh5gNmJIUEPxRUv4ffLBCefVpsAy2TEKRUtFUFLaCh0wL9lqAlqisJzkVcS0A9Vj5TGOTZIOIOg3xfr5eLqnkYhutVPsTl6WifPSm6dkEdZF8mnkQaUyxEAiNum5E6YKfFG4YoCjKGUTRJfjakcB0U9VWG/D/c7/dBRuj6tpcP8VFG3/f6oh5zuHqyHwbUm972GD9iHrtR0bSKR79oqVO5pXOJqvWsVStUSlplTdCKWkQtP1EDs0ZtoB8/y0ffdTMJwa506QH5DoGqoKNORZligbjzbVP6HUJHMYt2DGkYABriHTiCylP+AeT1WgnVJN2vULeIN9+03rSZ174pUTpPFKFW/iNxw05DQyBrZXn4wSiXZISQMRFV4IP+N8gj0eeraAyE3LdXG+2HiV1ue/5MwV4uH/JPhtdBtpNxMfBi7VJUJVXQKYY45pGS+fRRJ6JcjQDQKulhAOjhihkpjwS1g1apthm0iplP2b8iacecadcmi07qL5TTQasUqQWpOEZKenb1UPAKM8FyDNBqqAtAy6zsATFLuqeAe6hG3+tHcNDtZdacsXn0TaDF9aLUMietIo5RlFXVY3SFpuXjRFTwgYMqLbgxGZMCHxIU+1qrce+gTTHwUSD2tgi6O2dWvisunBYJViIcirYI0SCEYj3cjauQ9TWq9JAsZiDVWjVcvr8BTa020CZpMedVJLEVMwzHMscUo8mUl9+mXDZ9CjrpxaBC4xIEwB0oaKpHeAGa6pwl3fdZ0EhUHQ87QAvNEq+iGKNK2kWrwGLIj+hnVD2iKgh1RG3doNdEzR5Aw/Rl0G0FWkxdm12KAabkL3fEmSX7srXK0nYUHDmS8jqzGxj26DYpyxPAELRZZpU1jcbgXy9A+0wE2t5AaxCBSbgHtKbBzmel8lBJAaW8LjnLg3ngI3l+Vp2GlMdI0IoXU1GtRrDP6KArzIP6kz4rNAUO4zJ6We+4GbR4b1A7ncGWNxhvJmMot4LmI2GnmhaLJv6BDgVyDph/cODkTRCtucBa0GLoat+tP8iYt3sVpaOfAhhxSKCpAyeNbutSiEaYkkjaDErA7POpF9yXD9Rn6q6Dzmaj79d840Pkf70wLG62g9ZIR6lda5HTGKO5aIDm7KOZgPCnZsQLklENqISqiA2TsmE0cdqj6oNUknZPKCq9EbRg1vgKUmYcAtASWjF0oWIba0rj/T43UT+NqYfxDkiZ/GMg0TO5ZtAu52zlMuoWCW4aum2gSUfFe7cUtbI7l7QaY5OvJlChK/dlbjBLVc0TfUmiW1G9pkpTf8mNPtrWbMZX1aCJXjzTs1GdRfXVcGiGVOESNjOPWqt1IzKmaJMSfXnUDf8wKWVpGzsdnC2DMLcfTujw/QXzpWDeChqeEF7C8wGdO0GZjrfMpAMNifZRNAhwBxhD2DljeVAX5f8u6Z50GVjzVPwCmobjtKPUhCTHeTHUbXdRxSZolOvHG1UaoMVMo2Kb/U0ytgRlBnIIeri2nIiuGX3ffkULx4KYUD3h4bBLOT67cSIzqmajhlExObVTrs/Jh1zeaDOOeux0yU2IElJThd5dySvQHxcWbE57QL/BewcSyyGjVtdoMS0NNn2fg8aMDC5rqnUYBgteAkAXNmexylPQlwFtFwxVNoKGJ4TvJqM00C38eY5XQJ7VcYu9Q1dvUY5hyDNx8AhGnQuUmfaNZu7j4wno/tIi9j5Zd+y2POsR9aC2gNbQuaOCxMLr0PShPtFAK7ybSpiU3x9Br5UqDVdnywhhjdStglh+kEsuq28GfaL3bo1g8tK2nuoSlM7yNKeuLI+Yl4YmefBIBekDOvBgTpxWgrGgfl1r7vzhvJQUutkDmhVO5HVEvmQ5Ph+hHjmXpylUKLdJ2uac8bqA+4NPTBg8hH85hr20FtGu/GBPw3HYA5qTEKAVdagGQWdunZipluHqEZzXYR6aJoPwFbLvgQpyYIWJZmMHw2HdLbvk3JXEWteCjHeDi1qD8ZgjcIvH0fTRDKHidcbyeJ0y6FbZs2ozQZtRrkHTe5/YkrMJ8wkU+rOrc3/9F9AVy3PQOhpSOSMexvICNTqnCrJ7aR10+1GDvnTW67l9Bp6QTEKx5AG0XuQs6cLyPC1G0ENxguop48CJOTj1vyIRRl5XSfqL9z4dTztAA3N8DnrwZDliAaf+1JLbotTUrPSAdIfcizYNh1BJ2vxLm0Gv/EtJJm3N2ZGOTvP3klbYFpabSovZuxN0zaKV8g2u33kieq4OoK+PdtoYx44Uh1FoVtTaks8G7VD1rEBnlkdRO2hTDEIX9WAwUEm6zdm6VlPsVcYAmO/W6XncmD8/HI6chMMHWIYbEIJGBFXKgzkeHyMlDvWANWb8qtmoMfgjxCyF1xnL+8o42AGwq6mN3rsnnzOwDABEOZKmmLysGVNOhyWwvNEkbbzOQndjfBazWIaxEI/nmHc2cyCZdHES2lr1EjodBkUsuA10FnSKFWgkSUGcMVUt0eSSvhqv66uc3SPtf9vVWwblAGa4QgetX31L0KmA7jxBxgU7GiJCPcxbquHAD5jmVaZUTEefKfUzCr3dajTey5FLTG1RX5O0/pNrXklaoVn4HQiaMQKnp0zbyIjWZ2HO1xnqh4wBy1fH0y6Flji2OMK+gFbZcB6GStK0GzFSd8PdQUefokHteaiJR19KE9SQB9pvGd09rQpIgBVJF1H3UA+IupqI1oKQwEKGAjqTKatpeXGItNSS/62KfW3sWsaxe0CfjEJn0B4PQT3a3t68th4w05GaDpVe7g7aSgSWGmPxwvP8LUEP1zW9syz0rmT/qVZoFbSnXmn7envzDLozfhdpB+WectMmG0PkFpifMTbeZ1tXlYbEwZi0q1LQ5olY01FK2nI/JumBb74C7WE5QCN48YlopGSw+hC+ew9j2wK6zaCZhZZZeNzuvhXz3FHGJunW9QPvEzxaVNCR1gOcidbbwoCm0yTZbbQ2EDIl8zatO8O+rhy2KGz2l/77euwzvscWQbANVMAu7rnwPlfmQIO552iiNcIk0tZJeB+pHkFDRppwK9La77XZExbQHwjNr5bR/UYxnrBUeO/OeJcbj5IBupoRcNAi2FvKLE/m4v1+02asDNrqMGGofm/IWaUC+oOgh2S0/6UvfMas4b3bumuB6RSzpgRt1DhoNfGmw1uY5FPUoFH1RCqVn9WU2pPcqxqtxln9NVrL4esGuC+g6QnFGsMCXViJbq8Vv+lRYo1W+NFKxS23iuUcmYPWvgqrMPoFQvDQmiXyyDZb6DZ0JY7dKmZgvrmR+zBJWx3EU1hyCSHpYH0pOZeXcuwyLbTTYcygzUYPllXTUGIowQAFLc9+GrXbAVozuneRLxOCVj9vcz3ShC2sw0xX0l6awvFyqUskTdBuZ0ZL31nEQ9A5wu09pG3ZyLEL9NuRnvCj/2jLVKzVA7eDEjaqR9V7kKpOhElB57q41qTNdBB0a0FbNCLiOY7W+zoPO5siLjB1qDn6PMyhM7+uSvCYJVrXaL02py7xnkFreVz0KVjBFqB76LSALrZD1QPeexfo2nszMV8JOpN29QdI+Caqh/lpqx9mr70CrdacTgXSpl/VdFVcl8YvLAU1m0EfHHPrkm6/SNo5+8B0omKv8gZF5gxdGgslkXccnHsMGbTAVr6nBokkj3GseMKtq6pJ+89RJmFbN1cU6tF7yyj6pYbBSsVVLi+VErmB7opOZGbqE1H/ojyyEoBo4wVrjprj6XjcvBQc3VSXVeJhRfIKaE5B5jQGL3eucnljDXrwHkhHTZ1uqWe5s8NKQWVpx6Ykh5aChGfVrTcWt1AtLCjvIelkfVSDS9qFbI8cdDZyHROACR8BWUfSxTxhLAG2q6ua7YHGkr6Cbj2TIP4QFjdZnjyEin5ayiYpA0HkYlauJND0wzKpdi0UT32se+89oJ1Ct248HHRhedSOKzKgN5tcCtqJaZmTKXi4ZXQjg04GWqtEzqUHx7wvycEOsPliWcDLg6TJyFzSTNuy+YHOI7dOZ5XOoIu96LSPlpVmeUB3RUkH0e122Z2YOSABdils9FE9MFUA+kPeJJjhcNAxlWlYjIeB9gRaxfLkf5MDZd1292VvAswo9KWrCHTdQ8uWSktQiKSvnlaUN3/I5XnKV0HfTT1oL7rSqql31mw6nNlNtQc1vXf7vO0XZro0CCifznUIn2ExVROR3NStB4NwytxiRMXe1n2agXHsDvOMLh+tx75oX26Ha9XR0MNKB7rwAjqzPLMeBXTorKQUGOdYG5BcvfwWmITc2mHfCqwXLdfQ6Gvfl47ENnjLFNpzM+gHluegrQBmU5LpPEvW5DT9iF7ot4ddcn5dQ55fY76ss1d9qIvHwzqXlzuwCuiQQWuQdo9Gm9R4UB1zL/RmSR+sfHV5pc+WP7DUpn6zowBVweI1apaH8PueblnSHS0eEmkW1w4wICbp3Ia5EfTJEmDXS/uqJz/3HpoJsSose8CCtU8/srycFlsPS6cFczh8B1BoJGaOmxNgMBzXtn0hagsHrBBsEkvG8pDqjY8s73Z7Adosnic/+I6g0FyidNzhvWPbG+iP56BpUvtcIUpD7nZ10NniYfUFlforaLfTNHyQ9M2993GP4TjPSiiccjwH3VaSHqxJjSXvIumK5emSkWegO9p21SdMC6Fn7X/w3ge0YbavTce1L9qsnjzcra8nWAgwRrPM41M7/Qjakq32N2wbm2aHgT6ustAfT5SjbXNkyFxeh0ZG669T+4G0xleW9wo0lMOyfzoXWQo67DDQD1loBb2WeVv1grp6BO+HYAAgZDrec+J8LORDLIiBDqtwix+WFQNS6D3Lmb9gJvlfcY66MkJ7F3JjXa7Dik1OrLdEY3nC8KqJaNRq8GlohQ/RLDMce5RDvcp1hbFuN7TabJtpByviyRZ7OPgs2uQ9vjDSueZS2Kl1HpcYpvNGjh37mXESPoBGxxDqNMI5SvYuB7bW8pUbL0k5gD5aM8JYQPdZ0p7Iy8v84hRnloKe7rnzXGGOaIr4Yt0AWu61Hq949s50I7haBPYVpyoqzK0qBvpO0MxhM6zUNX3WYzaduZLpuH1dsiVmunoWmhuBkCnptqq4yxgG2jnOrITyuDO7qG0pk+eW0MM0NsaWAJpqVUJcbpxx2gMavdDnag2gReD9RwkFMk9y4AOXHrBKn2ACyuoL9NKQMxnokoCEpEG0brlzgTtJ7ZI0mk9AsYq5M9DIluYeylIFdkkPwa61SdpL4ro4P+V56KC1TqfKk6JVt4xfz3lV0M6YcKUdpX/WO8U9vesN79fgqdrAXiTqcbSaFiv50A6RudymprS/wcTB6FHL52X/SiZNgJ27ithVLWWMXj3Xbb2JmI1eU/NlNtk2J93TyKzHCMwr0OwLZ/MkQU+7697qVtaTcAW6rZbY9UWrZXizRl5GYT0fsQaNegtA34ukRysvarilTRjqvbHZ67cWbtXIcSqesGW2YNUliXQdw7jc2iBP9BriEbdivltxVrUjFfVI41xAm9sZBm9fsR4KmYS2derGfUnQfHKOOapUC1It2LCJN+TGTFPqgF084mB2musVYjXcI9q2RmwHAlyYSZuMU5qxoYpo6GnHZirw3vd6MXNbLdhwsu8xs/Uu9S0JA5d+DBT26OqRHLNKegW6DDY3Jey4+IVCfwv6eBI5r5NJXd095F3ucH6cdAgQ4FiQALBlhBD46GqR9SM9gDbCitV92LNEN+TEZhk7cqPcAeH98+l6cjPJmeR4ryJnXzFr3uJxj+thbqVs2Zsap1SR63h0S5V5QgLssL2f8WTe++OR6leELudXLJqz5FsqqptpWkbrvQf3B9D3O1gJvKI2h+uaW6xD3k6gHfN86fpaws4x+H+Jm0uSU5N3Bi6DTkWTCdz8dw16vk9sT9EliXG0PWRPb9UqyC3RlRiOJa9CqLLPrafMS7BvDR3RWtRq1XBJT3NeB6x7A80V4mVeEjauhJHGMh6NclBDZs/M5oUf3lds25pUdaC6ic2rw0NYSfMB9Iyt/XKQNc71WMDy7OehrGhmPfZt+7Igxldna9HtLnX36APotsv8bD3K7iIKenJeZwcerFGrTutiI+w3oQs2ImvIvkp94/IrxYx9INAiBwWBx2btqi/1d9HmO20ypldyXn/Tr+DWw7iopTxWm8LrTsNiPbh7uXwxzFLv/bZ9p2t2+bx/2q75uzboXxbcVk/wzABBNLLdUXd5We9kjy2vxORFO0hArlnnK5l2gT42b+/cNf/rBv3vtp9+vvN1q5Xqxbbx/ud5SqwKpHl+QIz2+ogtLbkXU+zuZ8axvwT95/ZH4877nYP23SrXoBN9JHY9CvUWXd+BfvDpJ5jIlYihY2+P5wjY0QJvJ3/Fib96Wh16oFvYo2UzRB4J8kTSti2TesLcKL8P9JN93/3wguN6N/inr1r9Po920J3n1AbnLQkfJc0uG92J9Wy9o7tB79yo/usuUw/XokHXodhyP/9lDTqRPylfzW1r/EPH7/shvr79t7/ymiUefDoX6Jrw1G2zl6mcAFODBr2ekDKzhIGuuPv/z69N2cC87fURW9hP9bE1tcnjwjlBHbnHjNbrfwx0eSEXO8TnqBuuAMWyKDMdx8MOrTz8IdAsnDrkNWhdgm1N1czpwndvBX3Y0Ze3/8pwp6BHQ40l2JbbizFX3Y7NVvV41Xn1/wDNNcMGtz5HZ+ZqZoa/dwf9b0hat3VXrS6+JW/n7Nspis3TnIHtHXvc1Dz6x/c6RWmdp+jM+fAs6LRvzCoq3bysx/4caOwCGqfqsDKAtnudbwH/74DG6hJhHxl1Bu17aXfrPVt+0Q39u6C3bcmKTY5APx2wHihhOq1u3EE3f0Wiv9789IAzUrDv/lhUw87dsg3t/0XQJ27uwCP2VoeF2fkM6R8EzZa+OJWJaIekNDzYYE6vdfrHxsH2Ci1n/vgBeGYBb93eguGfH9xb0Y+RmCvQdj6elpObt7d/D3SXz3+sQdOz30bvYPtZjahVnbtQV8dILJV6cFb6Zvs/DfpQeUSAtoMk6kMd/WzMZX5lPn5M0gJawls7RmIN2qgfTpD72Yn46Hl5vBLUeVkdpNncM+lDacij1J9WDer0+XOsJ+BK0jiTBnWWfwm09hQta7PxAFo1PYv6HwGNE6HmV6D12el2m3x1Uz7Y8vSn4pLv8h9H9llityNjpM9Bq4Iskxfivs8VZdB/5nqUNBON9HegURdAXmwH6NMfA2176I3T/M1ExNGZt4s3HP8CdPPboA/y77l5PWbMY8eYZXkmaT9Yc5ojjygtsH8xc3YF118OVX14buW/NW06zTxC8+sxx9Wxq6I/SddH8hTdfCLD/2X4eaxPnlw/B0k3xGwJj1eg7QjTNAyLbbZ/sMNl/+7ApllIqush20bvvpW0/9Q22/8hZ/6GE3jtRDM/BPbpRFxy0GiwP32j/WfHKr//kVFVis7jeJvzOWzT/Bp0Jezbpbcd85e/cAL2spwXnkmAmtzMjQ6IZXqm1g2N3cKTvf3M4FsKqGZHE/yzA5ztbPL1YcPlIN/lPqMdTdvh5e4dkrnPTw4org/gtn1IpnI06bOJ+D/nHM4ffjLteQAAAABJRU5ErkJggg==">
<title>Zoomer</title>
<style>
  :root { --bg:#f5f2ff; --bar:#e7e1ff; --ink:#1a1530; --muted:#5f587d; --line:#d6cdf7; --accent:#7c5cff; --link:#5a3fd6; --card:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12101c; --bar:#1d1933; --ink:#eeeafc; --muted:#a49dc4; --line:#302a52; --accent:#7c5cff; --link:#b4a3ff; --card:#1a1729; } }
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
  .logo { position: relative; margin-right: .08em; text-align: center; font-size: clamp(2.6rem, 9vw, 4.2rem); font-weight: 900; font-style: italic; letter-spacing: -0.04em; }
  .logo::before, .logo::after { content: ""; position: absolute; left: -26px; height: 4px; background: var(--accent); border-radius: 2px; }
  .logo::before { top: 42%; width: 20px; } .logo::after { top: 62%; width: 12px; opacity: .6; }
  .home form { position: relative; margin-top: 22px; width: min(560px, 100%); }
  .home input { display: block; width: 100%; font: inherit; padding: 14px 112px 14px 20px; border: 2px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); }
  .home form button { position: absolute; top: 6px; bottom: 6px; right: 6px; font-weight: 700; padding: 0 20px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; }
  .filters { display: flex; gap: 6px; overflow-x: auto; padding: 4px 0 10px; border-bottom: 1px solid var(--line); }
  .chip { flex: 0 0 auto; border: 0; background: none; padding: 8px 16px; border-radius: 999px; font-size: .9rem; color: var(--muted); }
  .chip:hover { background: var(--bar); }
  .chip.on { background: var(--accent); color: #fff; }
  .grid { display: grid; gap: 12px; padding-top: 14px; }
  .imgs { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .vids { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .shorts { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .tile { padding: 0; border: 0; background: var(--bar); border-radius: 10px; overflow: hidden; aspect-ratio: 1; cursor: zoom-in; }
  .tile img, .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .vcard { display: block; padding: 0; border: 0; background: none; text-align: left; }
  .thumb { aspect-ratio: 16 / 9; background: var(--bar); border-radius: 10px; overflow: hidden; display: grid; place-items: center; color: var(--muted); font-weight: 700; }
  .shorts .thumb { aspect-ratio: 9 / 16; }
  .vt { margin-top: 6px; font-size: .9rem; line-height: 1.3; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .vm { color: var(--muted); font-size: .8rem; }
  .more { display: block; margin: 20px auto 0; padding: 10px 22px; border: 2px solid var(--line); border-radius: 999px; background: var(--card); }
  .more:disabled { opacity: .5; }
  .ai { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 2px 18px 12px; margin-top: 14px; }
  .ai h2 { font-size: 1rem; margin: 14px 0 6px; } .ai p { margin: 8px 0; max-width: 65ch; }
  .ai .aino { color: var(--muted); font-size: .8rem; }
  .src { font-size: 1rem; margin: 22px 0 0; color: var(--muted); }
  .lb { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.88); color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; }
  .lb img { max-width: 92vw; max-height: 76vh; border-radius: 8px; cursor: pointer; background: #222; }
  .lb .cap { max-width: 92vw; text-align: center; font-size: .9rem; }
  .lb .xx { position: absolute; top: 12px; right: 14px; border: 0; background: rgba(255,255,255,.18); color: #fff; width: 38px; height: 38px; border-radius: 50%; font-size: 1.3rem; }
  #bar button:disabled { opacity: .35; cursor: default; }
  .result { padding: 16px 0; border-bottom: 1px solid var(--line); }
  .result .site { color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .result h2 { margin: 2px 0 4px; font-size: 1.2rem; line-height: 1.3; }
  .result a { color: var(--link); text-decoration: none; } .result a:hover { text-decoration: underline; }
  .result p { margin: 0; color: var(--muted); max-width: 65ch; }
  .msg { color: var(--muted); padding: 24px 0; }
  .msg.error { color: var(--ink); border-left: 4px solid var(--accent); padding-left: 14px; }
  .pager { display: flex; justify-content: space-between; padding-top: 20px; }
  .pager button { background: var(--card); border: 2px solid var(--line); border-radius: 999px; padding: 10px 20px; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .note { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); padding: 12px 14px; border-radius: 8px; color: var(--muted); font-size: .9rem; margin-top: 12px; }
  .note a { color: var(--link); }
  .col h1 { font-size: 1.5rem; line-height: 1.25; }
  .read { max-width: 65ch; }
</style>
</head>
<body>
<div id="tabs" role="tablist" aria-label="Tabs"></div>
<form id="bar">
  <button type="button" id="back" aria-label="Back" title="Back" disabled>&#8592;</button>
  <button type="button" id="reload" aria-label="Reload" title="Reload">&#8635;</button>
  <input id="url" type="text" placeholder="Search or type a web address" aria-label="Search or type a web address" autocomplete="off" spellcheck="false">
</form>
<div id="panes"></div>
<script>
const tabsEl = document.getElementById("tabs"), urlEl = document.getElementById("url"), panes = document.getElementById("panes");
let tabs = [], cur = null, uid = 0;
const backBtn = document.getElementById("back");

const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const msg = (x, c = "") => el("p", "msg " + c, x);
const col = (...n) => { const d = el("div", "col"); d.append(...n); return d; };
const addBtn = el("button", "", "+");
addBtn.id = "add"; addBtn.type = "button"; addBtn.title = "New tab"; addBtn.setAttribute("aria-label", "New tab");
addBtn.onclick = () => newTab();

function newTab() {
  if (tabs.length >= 12) return cur;
  const t = { kind: "home", title: "New tab", url: "", query: "", page: 1, seq: 0, hist: [], filter: "All", pane: el("section", "pane") };
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
  backBtn.disabled = !cur.hist.length;
  document.title = cur.kind === "home" ? "Zoomer" : cur.title + " \u2013 Zoomer";
}

function home(t) {
  t.kind = "home"; t.title = "New tab"; t.url = t.query = ""; t.seq++;
  const w = el("div", "home"), f = el("form"), i = el("input"), b = el("button", "", "Search");
  i.type = "search"; i.placeholder = "Search or type a web address"; i.setAttribute("aria-label", "Search or type a web address");
  b.type = "submit";
  f.onsubmit = e => { e.preventDefault(); go(t, i.value); };
  f.append(i, b); w.append(el("div", "logo", "Zoomer"), f); t.pane.replaceChildren(w);
}

function go(t, text) {
  text = text.trim(); if (!text) return;
  push(t); t.filter = "All";
  if (/^https?:\/\//i.test(text)) view(t, text);
  else if (/^[^\s\/]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) view(t, "https://" + text);
  else results(t, text, 1);
}

const FILTERS = ["AI Mode", "All", "Images", "Videos", "Short Videos"];
const TYPES = { "AI Mode": "ai", "Images": "images", "Videos": "videos", "Short Videos": "shorts" };

// Tab history for the Back button
const snap = t => t.kind === "home" ? { k: "h" } : t.kind === "results" ? { k: "r", q: t.query, p: t.page } : { k: "p", u: t.url };
const push = t => t.hist.push(snap(t));
function back() {
  const s = cur.hist.pop(); if (!s) return;
  if (s.k === "h") { home(cur); sync(); } else if (s.k === "r") results(cur, s.q, s.p); else view(cur, s.u);
}

// Video links that can be played inside Zoomer
function embedFor(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  const h = u.hostname.replace(/^(www|m)\./, ""), p = u.pathname; let m;
  if (h === "youtube.com") {
    const id = u.searchParams.get("v") || ((m = p.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)) && m[1]);
    return /^[\w-]{11}$/.test(id || "") ? "https://www.youtube.com/embed/" + id : null;
  }
  if (h === "youtu.be") { m = p.match(/^\/([\w-]{11})/); return m ? "https://www.youtube.com/embed/" + m[1] : null; }
  if (h === "vimeo.com") { m = p.match(/^\/(\d+)/); return m ? "https://player.vimeo.com/video/" + m[1] : null; }
  if (h === "tiktok.com") { m = p.match(/\/video\/(\d+)/); return m ? "https://www.tiktok.com/embed/v2/" + m[1] : null; }
  if (h === "dailymotion.com") { m = p.match(/\/video\/([a-z0-9]+)/i); return m ? "https://www.dailymotion.com/embed/video/" + m[1] : null; }
  return null;
}
const PLATFORMS = { "youtube.com": "YouTube", "youtu.be": "YouTube", "tiktok.com": "TikTok", "vimeo.com": "Vimeo", "dailymotion.com": "Dailymotion" };
const plat = u => { try { return PLATFORMS[new URL(u).hostname.replace(/^(www|m)\./, "")] || "Video"; } catch { return "Video"; } };
const ytThumb = em => { const m = (em || "").match(/youtube\.com\/embed\/([\w-]{11})/); return m ? "https://i.ytimg.com/vi/" + m[1] + "/hqdefault.jpg" : ""; };
const isShort = u => /youtube\.com\/shorts\//.test(u) || /tiktok\.com/.test(u);

function play(t, embed, title, url) {
  t.kind = "page"; t.url = url; t.title = title || plat(url); t.seq++; sync();
  const f = el("iframe"); f.title = t.title; f.src = embed;
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
  f.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
  f.allowFullscreen = true; t.pane.replaceChildren(f);
}

function resultItem(t, x) {
  const box = el("article", "result"), h = el("h2"), a = el("a", "", x.title || x.url);
  let host = x.url; try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch {}
  a.href = x.url; a.onclick = e => { e.preventDefault(); push(t); view(t, x.url); };
  h.append(a); box.append(el("div", "site", host), h, el("p", "", x.snippet)); return box;
}

function tabsRow(t, q, views) {
  const loaded = { All: true };
  const btns = FILTERS.map(name => { const b = el("button", "chip", name); b.type = "button"; b.onclick = () => select(name); return b; });
  const row = el("div", "filters"); row.append(...btns);
  function select(name) {
    t.filter = name;
    btns.forEach((b, i) => b.classList.toggle("on", FILTERS[i] === name));
    FILTERS.forEach(f => { views[f].hidden = f !== name; });
    if (!loaded[name]) { loaded[name] = true; loadMedia(t, q, name, views[name]); }
  }
  return { row, select };
}

async function results(t, q, page) {
  t.kind = "results"; t.query = q; t.page = page; t.title = q; const n = ++t.seq; sync();
  const views = {}; FILTERS.forEach(f => { views[f] = el("div"); });
  const body = views.All, { row, select } = tabsRow(t, q, views);
  body.append(msg("Searching\u2026"));
  t.pane.replaceChildren(col(row, ...FILTERS.map(f => views[f])));
  select(t.filter || "All");
  const show = (...x) => { if (n === t.seq) body.replaceChildren(...x); };
  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q) + "&page=" + page), d = await r.json();
    if (!r.ok) { show(msg(d.error || "Something went wrong.", "error")); return; }
    if (!d.results.length) { show(msg("No results for \u201c" + q + "\u201d. Try different words.")); return; }
    const pg = el("div", "pager"), pv = el("button", "", "Previous"), nx = el("button", "", "Next");
    pv.type = nx.type = "button"; pv.disabled = page <= 1;
    pv.onclick = () => { push(t); results(t, q, page - 1); }; nx.onclick = () => { push(t); results(t, q, page + 1); };
    pg.append(pv, nx); show(...d.results.map(x => resultItem(t, x)), pg); t.pane.scrollTop = 0;
  } catch {
    show(msg("Couldn\u2019t reach Zoomer\u2019s search. Check your connection and try again.", "error"));
  }
}

async function loadMedia(t, q, name, pane) {
  const type = TYPES[name];
  pane.replaceChildren(msg("Loading\u2026"));
  try {
    const r = await fetch("/api/media?type=" + type + "&q=" + encodeURIComponent(q)), d = await r.json();
    if (!r.ok) { pane.replaceChildren(msg(d.error || "Something went wrong.", "error")); return; }
    ({ ai: drawAI, images: drawImages, videos: drawVideos, shorts: drawShorts })[type](t, q, pane, d);
  } catch {
    pane.replaceChildren(msg("Couldn\u2019t load this tab. Check your connection and try again.", "error"));
  }
}

function drawAI(t, q, pane, d) {
  const box = el("div", "ai"); box.append(el("h2", "", "AI answer"));
  const parts = (d.answer || "").split(/\n+/).filter(Boolean);
  if (parts.length) { parts.forEach(x => box.append(el("p", "", x))); box.append(el("p", "aino", "AI answers can be wrong. Check the sources below.")); }
  else box.append(el("p", "", "The AI couldn\u2019t write an answer for this one. The web results are below."));
  pane.replaceChildren(box, el("h3", "src", "Sources"), ...d.items.map(x => resultItem(t, x)));
}

function drawImages(t, q, pane, d) {
  if (!d.items.length) { pane.replaceChildren(msg("No images found for \u201c" + q + "\u201d.")); return; }
  const grid = el("div", "grid imgs"), more = el("button", "more", "More images"); let page = 1;
  more.type = "button";
  const add = items => items.forEach(x => {
    const b = el("button", "tile"), i = el("img");
    b.type = "button"; i.src = x.thumb || x.img; i.alt = x.title || ""; i.loading = "lazy"; i.referrerPolicy = "no-referrer";
    b.onclick = () => lightbox(t, x); b.append(i); grid.append(b);
  });
  more.onclick = async () => {
    more.disabled = true;
    try {
      const r = await fetch("/api/media?type=images&q=" + encodeURIComponent(q) + "&page=" + (page + 1)), d2 = await r.json();
      if (r.ok && d2.items.length) { page++; add(d2.items); more.disabled = false; } else more.remove();
    } catch { more.disabled = false; }
  };
  add(d.items); pane.replaceChildren(grid, more);
}

function lightbox(t, x) {
  const lb = el("div", "lb"), img = el("img"), cap = el("div", "cap"), xb = el("button", "xx", "\u00d7");
  let host = ""; try { host = new URL(x.page).hostname.replace(/^www\./, ""); } catch {}
  img.src = x.img || x.thumb; img.alt = x.title || ""; img.referrerPolicy = "no-referrer";
  img.onerror = () => { if (x.thumb && img.src !== x.thumb) img.src = x.thumb; };
  cap.textContent = (x.title ? x.title + " \u00b7 " : "") + "Click the image again to visit " + (host || "the page");
  const key = e => { if (e.key === "Escape") close(); };
  const close = () => { lb.remove(); document.removeEventListener("keydown", key); };
  xb.type = "button"; xb.setAttribute("aria-label", "Close"); xb.onclick = close;
  lb.onclick = e => { if (e.target === lb) close(); };
  img.onclick = () => { close(); push(t); view(t, x.page || x.img); };
  document.addEventListener("keydown", key);
  lb.append(xb, img, cap); document.body.append(lb); xb.focus();
}

function videoGrid(t, list, cls, none) {
  if (!list.length) return msg(none);
  const grid = el("div", "grid " + cls);
  list.forEach(x => {
    const em = embedFor(x.url), b = el("button", "vcard"), th = el("div", "thumb"), src = ytThumb(em);
    b.type = "button";
    if (src) { const i = el("img"); i.src = src; i.alt = ""; i.loading = "lazy"; i.referrerPolicy = "no-referrer"; th.append(i); }
    else th.append(el("span", "", plat(x.url)));
    b.append(th, el("div", "vt", x.title || x.url), el("div", "vm", plat(x.url)));
    b.onclick = () => { push(t); play(t, em, x.title, x.url); };
    grid.append(b);
  });
  return grid;
}
function drawVideos(t, q, pane, d) {
  pane.replaceChildren(videoGrid(t, d.items.filter(x => embedFor(x.url) && !/youtube\.com\/shorts\//.test(x.url)), "vids", "No videos found for \u201c" + q + "\u201d."));
}
function drawShorts(t, q, pane, d) {
  pane.replaceChildren(videoGrid(t, d.items.filter(x => embedFor(x.url) && isShort(x.url)), "shorts", "No short videos found for \u201c" + q + "\u201d."));
}

async function view(t, raw) {
  let u;
  try { u = new URL(raw); if (u.protocol === "http:") u.protocol = "https:"; }
  catch { t.pane.replaceChildren(col(msg("That doesn\u2019t look like a web address.", "error"))); return; }
  const host = u.hostname.replace(/^www\./, ""), em = embedFor(u.href);
  if (em) { play(t, em, "", u.href); return; }
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
backBtn.onclick = back;
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
  if (path === "/api/media") return handleMedia(req);
  return new Response(HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
};

export const config: Config = { path: ["/", "/api/search", "/api/page", "/api/media"] };
