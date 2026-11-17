// Comic Tracker phone engine: does on the phone what server.py does on the PC.
// The page's api() calls are answered here; the library lives in this phone's IndexedDB.
// Sites that block web apps are reached through the relay (relay-worker.js on Cloudflare).
// It also runs inside the service worker (sw.js) for background checks, so it uses no DOM.
(function (root) {
  "use strict";
  const IS_PAGE = typeof document !== "undefined";
  // Inside the Android app (Capacitor) requests go out natively, so no relay is needed.
  const NATIVE = IS_PAGE && !!(root.Capacitor && root.Capacitor.isNativePlatform && root.Capacitor.isNativePlatform());
  const APP_UA = "ComicTracker/1.0 (personal use; android app)"; // MangaDex wants an honest client name
  const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const plugin = (n) => (root.Capacitor.Plugins && root.Capacitor.Plugins[n]) || root.Capacitor.registerPlugin(n);
  const MANGADEX_API = "https://api.mangadex.org";
  const DEFAULT_SETTINGS = { checkIntervalMinutes: 60, windowsToast: true, language: "en", dataSaver: false };
  const EDITABLE = new Set(["title", "status", "lastRead", "rating", "notes", "readUrl", "favorite", "tags"]);
  const STATUSES = new Set(["reading", "plan", "on-hold", "completed", "dropped"]);
  const RATINGS = [["contentRating[]", "safe"], ["contentRating[]", "suggestive"], ["contentRating[]", "erotica"]];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const toNum = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : +v);
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + now()).replace(/-/g, "");
  const qs = (pairs) => pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

  // ------------------------------------------------------------ storage (IndexedDB, shared with the service worker)
  let dbp = null;
  function db() {
    return dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("comic-tracker", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  async function idbGet(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = d.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("kv", "readwrite");
      t.objectStore("kv").put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  let DATA = null;
  function normalize(d) {
    d = d || {};
    return { series: d.series || [], history: d.history || [], events: d.events || [], lastCheck: d.lastCheck || null,
      settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
  }
  async function data(fresh) {
    if (!DATA || fresh) DATA = normalize(await idbGet("data"));
    return DATA;
  }
  const save = () => idbSet("data", DATA);
  const findSeries = (id) => DATA.series.find((s) => s.id === id) || null;
  function addHistory(s, action, chapter = null, extra = null) {
    DATA.history.unshift({ ts: now(), seriesId: s.id, title: s.title, action, chapter, ...(extra || {}) });
    DATA.history.length = Math.min(DATA.history.length, 2000);
  }

  // ------------------------------------------------------------ relay
  let RELAY = null; // { url, key }
  if (IS_PAGE) { try { RELAY = JSON.parse(localStorage.getItem("ct.relay") || "null"); } catch {} }
  async function relay() {
    if (NATIVE) return {};
    if (!RELAY) RELAY = (await idbGet("relay")) || null;
    if (!RELAY) throw new Error("The app isn't connected to its relay yet. Open Settings → Connection.");
    return RELAY;
  }
  async function setRelay(r) {
    RELAY = r && r.url ? { url: r.url.replace(/\/+$/, ""), key: r.key } : null;
    await idbSet("relay", RELAY);
    if (IS_PAGE) { try { RELAY ? localStorage.setItem("ct.relay", JSON.stringify(RELAY)) : localStorage.removeItem("ct.relay"); } catch {} }
  }
  const via = (u) => (NATIVE ? u : RELAY ? `${RELAY.url}/?k=${encodeURIComponent(RELAY.key)}&u=${encodeURIComponent(u)}` : "");

  const isMangadex = (host) => /(^|\.)mangadex\.(org|network)$/.test(host);
  function b64bytes(s) {
    const bin = atob(s), a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  async function nativeFetch(url) {
    const r = await plugin("CapacitorHttp").request({
      url, method: "GET", responseType: "arraybuffer", connectTimeout: 20000, readTimeout: 30000,
      headers: { "User-Agent": isMangadex(new URL(url).hostname) ? APP_UA : BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    let body = r.data;
    if (typeof body === "string") { try { body = b64bytes(body); } catch { body = new TextEncoder().encode(body); } }
    else if (body && typeof body === "object") body = new TextEncoder().encode(JSON.stringify(body));
    const h = new Headers();
    for (const [k, v] of Object.entries(r.headers || {})) { try { h.set(k, String(v)); } catch {} }
    return new Response(r.status === 204 || r.status === 304 ? null : body || null, { status: r.status || 200, headers: h });
  }

  async function get(url) {
    await relay();
    let res;
    try { res = NATIVE ? await nativeFetch(url) : await fetch(via(url)); } catch { throw new Error("No connection. Check your internet and try again."); }
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.clone().json()).error || ""; } catch {}
      if (res.status === 403 && msg === "Wrong relay key") throw new Error("The relay key is wrong. Check Settings → Connection.");
      if (res.status === 429) throw new Error("Too many requests to " + new URL(url).hostname + ". Wait a minute and try again.");
      throw new Error(msg || `${new URL(url).hostname} answered ${res.status}`);
    }
    return res;
  }
  const getJson = async (url) => (await get(url)).json();
  async function getText(url) {
    const res = await get(url);
    const buf = await res.arrayBuffer();
    const m = /charset=([\w-]+)/i.exec(res.headers.get("Content-Type") || "");
    try { return new TextDecoder(m ? m[1] : "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
  }

  // ------------------------------------------------------------ MangaDex
  function mdTitle(a) {
    const t = a.title || {};
    if (t.en) return t.en;
    for (const alt of a.altTitles || []) if (alt.en) return alt.en;
    return Object.values(t)[0] || "Untitled";
  }
  function mdCover(m) {
    for (const r of m.relationships || []) if (r.type === "cover_art" && r.attributes) return `https://uploads.mangadex.org/covers/${m.id}/${r.attributes.fileName}.256.jpg`;
    return null;
  }
  function mdResult(m) {
    const a = m.attributes;
    return { source: "mangadex", sourceId: m.id, title: mdTitle(a), cover: mdCover(m), url: "https://mangadex.org/title/" + m.id,
      status: a.status, year: a.year, kind: { ko: "Manhwa", zh: "Manhua", "zh-hk": "Manhua", ja: "Manga" }[a.originalLanguage] || "Comic",
      description: ((a.description || {}).en || "").slice(0, 400) };
  }
  async function mangadexSearch(q) {
    const d = await getJson(MANGADEX_API + "/manga?" + qs([["title", q], ["limit", "20"], ["includes[]", "cover_art"], ["order[relevance]", "desc"], ...RATINGS]));
    return (d.data || []).map(mdResult);
  }
  async function mangadexLatest(id, language) {
    const d = await getJson(`${MANGADEX_API}/manga/${id}/feed?` + qs([["translatedLanguage[]", language], ["order[chapter]", "desc"], ["order[publishAt]", "desc"],
      ["limit", "5"], ["includeFuturePublishAt", "0"], ...RATINGS]));
    for (const ch of d.data || []) {
      const a = ch.attributes;
      if (a.chapter == null) continue;
      return { chapter: a.chapter, chapterTitle: a.title || "", url: a.externalUrl || "https://mangadex.org/chapter/" + ch.id, publishedAt: a.publishAt };
    }
    return null;
  }
  async function mangadexById(id) {
    const d = await getJson(`${MANGADEX_API}/manga/${id}?includes[]=cover_art`);
    const r = mdResult(d.data);
    r.latest = await mangadexLatest(id, DATA.settings.language || "en");
    return r;
  }

  // ------------------------------------------------------------ text helpers (no DOM, so they also work in the service worker)
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : (ENT[e.toLowerCase()] ?? m));
  const stripTags = (s) => decode(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  function attrs(tag) {
    const out = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
    return out;
  }
  const tagText = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i").exec(xml); return m ? decode(m[1]).trim() : null; };

  // ------------------------------------------------------------ RSS (Webtoons etc.)
  async function parseRss(url) {
    const xml = await getText(url);
    const firstItem = xml.search(/<(item|entry)\b/i);
    const head = firstItem < 0 ? xml : xml.slice(0, firstItem);
    const imageBlock = /<image\b[^>]*>([\s\S]*?)<\/image>/i.exec(head);
    const items = [];
    for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const b = m[2], item = {};
      const t = tagText(b, "title"); if (t !== null) item.title = stripTags(t);
      const l = tagText(b, "link");
      if (l) item.link = l; else { const lm = /<link\b[^>]*href=["']([^"']+)/i.exec(b); if (lm) item.link = decode(lm[1]); }
      const date = tagText(b, "pubDate") || tagText(b, "published") || tagText(b, "updated"); if (date) item.date = date;
      items.push(item);
    }
    if (!items.length && !/<(rss|feed|channel)\b/i.test(xml)) throw new Error("That link isn't an RSS feed");
    return [stripTags(tagText(head, "title") || ""), imageBlock ? tagText(imageBlock[1], "url") : null, items];
  }
  function rssChapterNumber(item) {
    let m = /episode_no=(\d+)/.exec(item.link || ""); if (m) return m[1];
    m = /(?:ep(?:isode)?|ch(?:apter)?)\.?\s*(\d+(?:\.\d+)?)/i.exec(item.title || ""); if (m) return m[1];
    m = /(\d+(?:\.\d+)?)/.exec(item.title || ""); return m ? m[1] : null;
  }
  function bestRss(items) {
    let best = null;
    for (const item of items) {
      const n = rssChapterNumber(item);
      if (n === null) continue;
      if (!best || toNum(n) > toNum(best.chapter)) best = { chapter: n, chapterTitle: item.title || "", url: item.link, publishedAt: item.date };
    }
    return best;
  }
  const rssLatest = async (url) => bestRss((await parseRss(url))[2]);
  function webtoonRssUrl(url) {
    const p = new URL(url);
    if (p.hostname.includes("webtoons.com") && !p.pathname.includes("/rss")) {
      const no = p.searchParams.get("title_no");
      if (no) {
        let path = p.pathname.replace(/\/+$/, "").replace(/\/(list|episode-\d+\/viewer|viewer)\/?$/, "").replace(/\/[^/]+\/viewer$/, "");
        return `https://www.webtoons.com${path}/rss?title_no=${no}`;
      }
    }
    return url;
  }
  async function rssPreview(url) {
    const feed = webtoonRssUrl(url);
    const [title, image, items] = await parseRss(feed);
    const page = feed !== url ? url : (items[0] && items[0].link) || url;
    return { source: "rss", sourceId: feed, title: title || feed, cover: image, url: page,
      kind: feed.includes("webtoons.com") ? "Webtoon" : "Comic", latest: bestRss(items), items: items.length };
  }

  // ------------------------------------------------------------ any website link
  const CHAPTER_RE = /(?:chapter|chap|ch|episode|ep)[\s._\-#]*(\d{1,5}(?:\.\d+)?)/i;
  function guessKind(text) {
    text = text.toLowerCase();
    for (const [w, k] of [["webtoon", "Webtoon"], ["manhwa", "Manhwa"], ["manhua", "Manhua"], ["manga", "Manga"]]) if (text.includes(w)) return k;
    return "Comic";
  }
  async function scanPage(url) {
    const html = await getText(url);
    const meta = {};
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const a = attrs(m[0]), key = (a.property || a.name || "").toLowerCase();
      if (["og:title", "og:image", "twitter:image"].includes(key) && a.content && !(key in meta)) meta[key] = a.content.trim();
    }
    const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const pageTitle = tm ? decode(tm[1]).replace(/\s+/g, " ").trim() : "";
    const segs = new URL(url).pathname.split("/").filter((s) => s && !/^\d+$/.test(s));
    const slug = segs.length ? segs[segs.length - 1] : "";
    let chapters = [];
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const a = attrs(m[1]);
      if (!a.href) continue;
      const text = ((a.title || "") + " " + stripTags(m[2])).replace(/\s+/g, " ").trim();
      let full;
      try { full = new URL(a.href, url).toString(); } catch { continue; }
      let path = new URL(full).pathname;
      try { path = decodeURIComponent(path); } catch {}
      const hit = CHAPTER_RE.exec(text) || CHAPTER_RE.exec(path.split("/").pop() || path);
      if (hit) chapters.push([hit[1], full, text, !!slug && path.toLowerCase().includes(slug.toLowerCase())]);
    }
    if (chapters.some((c) => c[3])) chapters = chapters.filter((c) => c[3]);
    let best = null;
    for (const [n, full, text] of chapters) if (!best || toNum(n) > toNum(best.chapter)) best = { chapter: n, chapterTitle: text.slice(0, 120), url: full, publishedAt: null };
    let title = meta["og:title"] || pageTitle || new URL(url).hostname;
    title = title.split(/\s+[|\-–—]\s+/)[0].replace(/^read\s+/i, "")
      .replace(/\s+(latest chapters?|all chapters|read (manga |manhwa )?online|(manga |manhwa )?online free|for free)\b.*$/i, "").trim();
    const words = slug.replace(/-[0-9a-f]{6,}$/, "").split("-").filter(Boolean);
    if (words.length > 1 && !words.some((w) => w.length > 2 && title.toLowerCase().includes(w.toLowerCase())))
      title = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    const cover = meta["og:image"] || meta["twitter:image"];
    return { title, cover: cover ? new URL(cover, url).toString() : null, best, count: chapters.length, chapters };
  }
  async function linkPreview(url) {
    let p;
    try { p = new URL(url); } catch { throw new Error("Paste a full link starting with https://"); }
    if (!/^https?:$/.test(p.protocol)) throw new Error("Paste a full link starting with https://");
    if (p.hostname.includes("webtoons.com") || /(rss|feed|\.xml)/i.test(p.pathname)) return rssPreview(url);
    const m = /\/title\/([0-9a-f-]{36})/.exec(url);
    if (p.hostname.includes("mangadex.org") && m) return mangadexById(m[1]);
    const s = await scanPage(url);
    const base = { title: s.title, cover: s.cover, url, kind: guessKind(p.hostname + " " + s.title), site: p.hostname };
    if (s.best && s.count >= 2) return { ...base, source: "web", sourceId: url, latest: s.best, items: s.count,
      description: `Found ${s.count} chapter links on ${p.hostname}. New chapters will be checked automatically.` };
    return { ...base, source: "manual", sourceId: "", readUrl: url, latest: null,
      description: `Couldn't read chapter numbers from ${p.hostname} (the site may load them with scripts or block apps). It will be saved with your link, and you update the latest chapter yourself.` };
  }

  // ------------------------------------------------------------ notifications and update checks
  async function notify(title, body) {
    if (NATIVE) {
      if (!DATA.settings.windowsToast) return;
      const LN = plugin("LocalNotifications");
      let perm = await LN.checkPermissions();
      if (perm.display === "prompt" || perm.display === "prompt-with-rationale") perm = await LN.requestPermissions();
      if (perm.display !== "granted") return;
      await LN.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title, body, extra: { tab: "updates" } }] });
      return;
    }
    if (!DATA.settings.windowsToast || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const reg = IS_PAGE ? await navigator.serviceWorker?.ready : root.registration;
    if (reg) await reg.showNotification(title, { body, icon: "icon-192.png", badge: "icon-192.png", tag: "ct-new", data: { url: "./?tab=updates" } });
  }
  async function checkSeries(s) {
    if (s.source === "mangadex") return mangadexLatest(s.sourceId, DATA.settings.language || "en");
    if (s.source === "rss") return rssLatest(s.sourceId);
    if (s.source === "web") return (await scanPage(s.sourceId)).best;
    return null;
  }
  let checking = false;
  async function runCheck(onlyId) {
    if (checking) return { busy: true, new: [] };
    checking = true;
    const fresh = [];
    try {
      await data(true); // the service worker or another tab may have saved changes
      const targets = DATA.series.filter((s) => s.source !== "manual" && (!onlyId || s.id === onlyId) && s.status !== "dropped").map((s) => ({ ...s }));
      for (const snap of targets) {
        let latest = null, err = null;
        try { latest = await checkSeries(snap); } catch (e) { err = e.message; }
        await data(true);
        const s = findSeries(snap.id);
        if (!s) continue;
        s.lastChecked = now(); s.checkError = err;
        if (latest) {
          const old = toNum(s.latestChapter), nv = toNum(latest.chapter);
          if (s.latestChapter == null || (nv !== null && (old === null || nv > old))) {
            const first = s.latestChapter == null;
            Object.assign(s, { latestChapter: latest.chapter, latestUrl: latest.url, latestTitle: latest.chapterTitle, latestAt: now() });
            if (!first) {
              const ev = { id: newId(), ts: now(), seriesId: s.id, title: s.title, chapter: latest.chapter, url: latest.url };
              DATA.events.unshift(ev); DATA.events.length = Math.min(DATA.events.length, 500);
              addHistory(s, "new-chapter", latest.chapter);
              fresh.push(ev);
            }
          }
        }
        await save();
        if (snap.source === "mangadex") await sleep(400); // stay well under MangaDex's ~5 requests a second
      }
      if (!onlyId) DATA.lastCheck = now();
      await save();
    } finally { checking = false; }
    if (fresh.length === 1) await notify("New chapter: " + fresh[0].title, `Chapter ${fresh[0].chapter} is out`);
    else if (fresh.length) await notify(`${fresh.length} new chapters`, fresh.slice(0, 4).map((e) => `${e.title} (${e.chapter})`).join(", "));
    return { busy: false, new: fresh };
  }

  // ------------------------------------------------------------ reading
  const chapterCache = new Map(), pagesCache = new Map();
  async function mangadexChapters(id, language) {
    const found = new Map();
    for (let offset = 0; ; ) {
      const d = await getJson(`${MANGADEX_API}/manga/${id}/feed?` + qs([["translatedLanguage[]", language], ["order[chapter]", "asc"], ["limit", "500"],
        ["offset", String(offset)], ["includes[]", "scanlation_group"], ["includeFuturePublishAt", "0"], ...RATINGS]));
      for (const ch of d.data || []) {
        const a = ch.attributes, external = a.externalUrl;
        if (!a.pages && !external) continue;
        const groups = (ch.relationships || []).filter((r) => r.type === "scanlation_group" && r.attributes).map((r) => r.attributes.name);
        const item = { id: ch.id, chapter: a.chapter, title: a.title || "", pages: a.pages || 0, group: groups.join(", "), external: !!external,
          site: "MangaDex", url: external || "https://mangadex.org/chapter/" + ch.id };
        const key = a.chapter || ch.id;
        if (!found.has(key) || (found.get(key).external && !external)) found.set(key, item);
      }
      offset += 500;
      if (offset >= (d.total || 0) || offset >= 9500) break;
      await sleep(250);
    }
    return [...found.values()].sort((x, y) => (toNum(x.chapter) === null) - (toNum(y.chapter) === null) || (toNum(x.chapter) || 0) - (toNum(y.chapter) || 0));
  }
  function linkedChapters(pairs, site) {
    const found = new Map();
    for (const [n, url, title] of pairs) if (n != null && !found.has(n)) found.set(n, { id: n, chapter: n, title, pages: 0, group: "", external: true, site, url });
    return [...found.values()].sort((x, y) => (toNum(x.chapter) || 0) - (toNum(y.chapter) || 0));
  }
  async function seriesChapters(s, refresh) {
    const language = DATA.settings.language || "en", c = chapterCache.get(s.id);
    if (c && !refresh && c.until > now() && c.language === language) return c.list;
    let list = [];
    const host = (u) => { try { return new URL(u).hostname; } catch { return "the website"; } };
    if (s.source === "mangadex") list = await mangadexChapters(s.sourceId, language);
    else if (s.source === "rss") list = linkedChapters((await parseRss(s.sourceId))[2].map((i) => [rssChapterNumber(i), i.link, i.title || ""]), host(s.sourceId));
    else if (s.source === "web") list = linkedChapters((await scanPage(s.sourceId)).chapters.map((c) => [c[0], c[1], c[2]]), host(s.sourceId));
    chapterCache.set(s.id, { until: now() + 300000, language, list });
    return list;
  }
  async function chapterPages(id, refresh) {
    const quality = DATA.settings.dataSaver ? "data-saver" : "data", c = pagesCache.get(id);
    if (c && !refresh && c.until > now() && c.quality === quality) return c.urls;
    const info = await getJson(MANGADEX_API + "/at-home/server/" + id);
    const ch = info.chapter, files = quality === "data-saver" ? ch.dataSaver : ch.data;
    const urls = files.map((name) => `${info.baseUrl}/${quality}/${ch.hash}/${name}`);
    pagesCache.set(id, { until: now() + 600000, quality, urls }); // MangaDex guarantees these links for 15 minutes
    return urls;
  }

  // ------------------------------------------------------------ search by story (same method as server.py)
  const CATALOG_SIZE = 5000, CATALOG_MAX_AGE = 14 * 86400e3, WIKI_PAUSE = 8000;
  const STOPWORDS = new Set(`a about after again all also am an and any are as at be because been before being but by can could did do does
down during each even ever every few for from get gets getting go goes going got had has have he her here hers him his how i if in
into is it its just like make makes many me more most much my new no not now of off on once one only or other our out over own
really same she should so some something somehow someone story such than that the their them then there these they thing things
this those through to too two under until up us very want wants was we were what when where which while who whom why will with
would you your comic comics manga manhwa manhua webtoon series plot main character characters protagonist mc guy person people
called named kind sort lot think remember forgot original read reading book`.split(/\s+/));
  const CONCEPTS = [
    ["going back in time", ["Time Travel"], "regress regressor regression timeloop", ["back in time", "back to the past", "second chance", "time travel", "time loop", "years in the past", "turned back", "travels back", "goes back", "go back to"]],
    ["reincarnation", ["Reincarnation"], "reincarnat reborn rebirth transmigrat", ["born again", "past life", "previous life", "second life", "reborn as"]],
    ["another world", ["Isekai"], "isekai summon transport", ["another world", "different world", "other world", "fantasy world", "parallel world", "world of a novel", "inside a novel", "inside a game", "trapped in a"]],
    ["villainess", ["Villainess"], "villainess otome", ["villain of", "evil noble"]],
    ["game system", ["Video Games", "Virtual Reality"], "system vrmmo mmorpg rpg gamer quest", ["level up", "levels up", "leveling up", "status window", "game world", "video game", "skill points"]],
    ["monsters and hunters", ["Monsters"], "monster hunter dungeon gate beast raid", []],
    ["martial arts", ["Martial Arts", "Wuxia"], "martial murim cultivat cultivator sect wuxia kungfu dao jianghu wulin", ["kung fu", "jiang hu"]],
    ["revenge", [], "revenge avenge vengeance betray", ["get back at", "pay back"]],
    ["the Monkey King", [], "wukong", ["monkey king", "sun wukong", "son goku", "journey to the west"]],
    ["assassins", [], "assassin assassinate assassination hitman", ["trained killer"]],
    ["kidnapping", [], "kidnap abduct captive", []],
    ["teenage lead", [], "teen teenager adolescent", ["high school", "year old"]],
    ["romance", ["Romance"], "romance love lover crush boyfriend girlfriend marriage wedding husband wife", ["falls for", "fall for"]],
    ["school life", ["School Life"], "school student classmate teacher highschool academy", ["high school"]],
    ["zombies", ["Zombies"], "zombie undead", []],
    ["vampires", ["Vampires"], "vampire", []],
    ["demons", ["Demons"], "demon devil", []],
    ["ghosts", ["Ghosts"], "ghost spirit haunt", []],
    ["aliens", ["Aliens"], "alien extraterrestrial", []],
    ["samurai", ["Samurai"], "samurai ronin", []],
    ["ninja", ["Ninja"], "ninja shinobi", []],
    ["gangs and crime", ["Mafia", "Crime", "Delinquents"], "mafia gang yakuza delinquent gangster crime", []],
    ["magic", ["Magic"], "magic mage wizard sorcerer witch spell sorcery", []],
    ["survival", ["Survival"], "survival survive", ["death game", "battle royale"]],
    ["end of the world", ["Post-Apocalyptic"], "apocalypse apocalyptic", ["end of the world", "post apocalyptic"]],
    ["office life", ["Office Workers"], "salaryman employee", ["office worker", "office job", "company worker"]],
    ["cooking", ["Cooking"], "cook chef restaurant", []],
    ["sports", ["Sports"], "sport football soccer basketball baseball volleyball boxing tennis athlete", []],
    ["music", ["Music"], "music band singer idol guitar piano", []],
    ["medicine", ["Medical"], "doctor surgeon hospital nurse", []],
    ["superheroes", ["Superhero"], "superhero superpower quirk", []],
    ["giant robots", ["Mecha"], "mecha robot", []],
    ["horror", ["Horror"], "horror terrify", []],
    ["mystery", ["Mystery"], "mystery detective murder", []],
    ["war and soldiers", ["Military"], "military soldier army", []],
    ["swordsmanship", [], "sword swordsman swordmaster blade knight", []],
    ["royalty", [], "king queen prince princess emperor empress duke kingdom noble", []],
    ["overpowered lead", [], "overpower invincible strongest", ["op mc", "most powerful"]],
    ["weak lead", [], "weakest weak useless", ["low rank", "lowest rank"]],
  ];
  const ORIGINS = [["from Korea", "Manhwa", /\b(korea|korean|manhwa)\b/g], ["from Japan", "Manga", /\b(japan|japanese)\b/g], ["from China", "Manhua", /\b(china|chinese|manhua)\b/g]];

  function stem(word) {
    word = word.toLowerCase().replace(/'s/g, "").replace(/’s/g, "");
    let cut = false;
    for (const suf of ["ing", "ion", "ed", "es", "ly"]) {
      if (word.endsWith(suf) && word.length - suf.length >= 4) {
        word = word.slice(0, -suf.length);
        if ((suf === "ing" || suf === "ed") && word.at(-1) === word.at(-2) && !"lsz".includes(word.at(-1))) word = word.slice(0, -1);
        cut = true;
        break;
      }
    }
    if (!cut && word.endsWith("s") && !word.endsWith("ss") && word.length > 3) word = word.slice(0, -1);
    return word.endsWith("e") && word.length > 4 ? word.slice(0, -1) : word;
  }
  const wordsOf = (text) => text.toLowerCase().match(/[a-z0-9'’]+/g) || [];
  const COMPILED = CONCEPTS.map(([label, tags, words, phrases]) => [label, new Set(tags.map((t) => t.toLowerCase())), new Set(words.split(" ").map(stem)), phrases]);
  const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
  function conceptsIn(lower, stems, tags) {
    const out = new Set();
    for (const [label, ctags, cwords, phrases] of COMPILED)
      if (overlap(ctags, tags) || overlap(cwords, stems) || phrases.some((p) => lower.includes(p))) out.add(label);
    return out;
  }
  function queryTerms(query) {
    const lower = wordsOf(query).join(" ");
    const stems = new Set(wordsOf(query).filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem));
    const ideas = new Set(), used = new Set();
    for (const [label, , , phrases] of COMPILED)
      for (const p of phrases) if (lower.includes(p)) { ideas.add(label); wordsOf(p).forEach((w) => used.add(stem(w))); }
    for (const [label, , cwords] of COMPILED) {
      const hit = [...stems].filter((s) => !used.has(s) && cwords.has(s));
      if (hit.length) { ideas.add(label); hit.forEach((h) => used.add(h)); }
    }
    for (const [label, , re] of ORIGINS) {
      const found = [...lower.matchAll(re)].map((m) => m[1]);
      if (found.length) { ideas.add(label); found.forEach((w) => used.add(stem(w))); }
    }
    return [ideas, new Set([...stems].filter((s) => !used.has(s)))];
  }

  const catalog = { items: [], state: "empty", done: 0, built: 0, index: null, retryAt: 0 };
  let wikiPlots = {}, wikiLoaded = false;
  function indexCatalog(items) {
    const docs = [], df = new Map();
    for (const item of items) {
      const text = [item.title, item.summary, item.tags.join(" "), wikiPlots[item.sourceId] || ""].join(" ").toLowerCase();
      const stems = new Set(wordsOf(text).filter((w) => !STOPWORDS.has(w)).map(stem));
      const ideas = conceptsIn(text, stems, new Set(item.tags.map((t) => t.toLowerCase())));
      for (const [label, kind] of ORIGINS) if (item.kind === kind) ideas.add(label);
      docs.push([stems, ideas]);
      for (const k of stems) df.set(k, (df.get(k) || 0) + 1);
      for (const k of ideas) df.set(k, (df.get(k) || 0) + 1);
    }
    return [docs, df];
  }
  async function loadWiki() {
    if (wikiLoaded) return;
    wikiLoaded = true;
    wikiPlots = (await idbGet("wiki")) || {};
    if (!Object.keys(wikiPlots).length && IS_PAGE) {
      try { wikiPlots = await (await fetch("wiki-plots.json")).json(); await idbSet("wiki", wikiPlots); } catch {} // plots collected on the PC so far
    }
  }
  async function fetchCatalog() {
    const items = [];
    for (let offset = 0; offset < CATALOG_SIZE; offset += 100) {
      let d;
      for (let attempt = 0; ; attempt++) {
        try {
          d = await getJson(MANGADEX_API + "/manga?" + qs([["limit", "100"], ["offset", String(offset)], ["order[followedCount]", "desc"], ["includes[]", "cover_art"],
            ["contentRating[]", "safe"], ["contentRating[]", "suggestive"]]));
          break;
        } catch (e) {
          if (attempt === 3) return items; // keep what arrived; a short index still works
          await sleep(5000 * (attempt + 1));
        }
      }
      for (const m of d.data || []) {
        const a = m.attributes, r = mdResult(m);
        r.summary = ((a.description || {}).en || "").slice(0, 1500);
        r.tags = (a.tags || []).map((t) => (t.attributes.name || {}).en || "");
        r.languages = a.availableTranslatedLanguage || [];
        items.push(r);
      }
      catalog.done = items.length;
      if ((d.data || []).length < 100) break;
      await sleep(1000);
    }
    return items;
  }
  let catalogJob = null;
  function ensureCatalog() {
    return catalogJob || (catalogJob = (async () => {
      try {
        await loadWiki();
        if (!catalog.items.length) {
          const saved = await idbGet("catalog");
          if (saved && saved.items && saved.items.length) {
            Object.assign(catalog, { items: saved.items, built: saved.built, done: saved.items.length, index: indexCatalog(saved.items), state: "ready" });
          }
        }
        if (catalog.items.length && now() - catalog.built < CATALOG_MAX_AGE) return;
        catalog.state = catalog.items.length ? "refreshing" : "building";
        const items = await fetchCatalog();
        if (!items.length) throw new Error("MangaDex sent no series");
        let built = now();
        if (items.length < CATALOG_SIZE * 0.9) built -= CATALOG_MAX_AGE - 86400e3; // cut short: try for the rest tomorrow
        await idbSet("catalog", { built, items });
        Object.assign(catalog, { items, built, index: indexCatalog(items), state: "ready" });
      } catch (e) {
        catalog.state = catalog.items.length ? "ready" : "failed";
        catalog.retryAt = now() + 600000;
        catalog.error = e.message;
      } finally { catalogJob = null; }
    })());
  }

  async function wikiQuery(params) {
    const url = "https://en.wikipedia.org/w/api.php?" + qs(Object.entries({ format: "json", origin: "*", ...params }));
    for (let attempt = 0; ; attempt++) {
      await sleep(WIKI_PAUSE);
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (res.status !== 429 || attempt === 3) throw new Error("Wikipedia answered " + res.status);
      await sleep((+(res.headers.get("Retry-After") || 60) + 5) * 1000);
    }
  }
  async function wikiArticleTitles(items) {
    const tried = {};
    for (const it of items) tried[it.sourceId] = ["manga", "manhwa", "manhua", "webtoon"].map((k) => `${it.title} (${k})`).concat([it.title]);
    const q = (await wikiQuery({ action: "query", prop: "info", redirects: 1, titles: Object.values(tried).flat().join("|") })).query;
    const moved = {};
    for (const e of (q.normalized || []).concat(q.redirects || [])) moved[e.from] = e.to;
    const exists = new Set(Object.values(q.pages || {}).filter((p) => !("missing" in p) && !("invalid" in p)).map((p) => p.title));
    const found = {};
    for (const [sid, options] of Object.entries(tried)) {
      for (let name of options) {
        let guard = 0;
        while (moved[name] && moved[name] !== name && guard++ < 5) name = moved[name];
        if (exists.has(name)) { found[sid] = name; break; }
      }
    }
    return found;
  }
  async function wikiPlot(title) {
    const pages = (await wikiQuery({ action: "query", prop: "extracts", explaintext: 1, exsectionformat: "wiki", redirects: 1, titles: title })).query.pages;
    const text = Object.values(pages)[0].extract || "";
    const parts = text.split(/\n==\s*([^=\n]+?)\s*==\n/);
    if (!/manga|manhwa|manhua|webtoon|comic/i.test(parts[0].slice(0, 800))) return "";
    const keep = [parts[0]];
    for (let i = 1; i + 1 < parts.length; i += 2) if (/plot|synopsis|premise|story|summary|character/i.test(parts[i])) keep.push(parts[i + 1]);
    return keep.join("\n").slice(0, 20000);
  }
  let wikiRunning = false;
  async function enrichWithWikipedia() {
    // Summaries are short, so fuller plots are added from Wikipedia while the app is open. It resumes next time.
    if (wikiRunning || !IS_PAGE) return;
    wikiRunning = true;
    try {
      let failures = 0, sinceSave = 0;
      const todo = catalog.items.filter((i) => !(i.sourceId in wikiPlots) && !/[|\[\]{}#<>_]/.test(i.title)).sort((a, b) => (a.kind === "Manga") - (b.kind === "Manga"));
      for (let start = 0; start < todo.length; start += 10) {
        while (document.hidden) await sleep(5000);
        const batch = todo.slice(start, start + 10);
        try {
          const articles = await wikiArticleTitles(batch);
          for (const it of batch) { const t = articles[it.sourceId]; wikiPlots[it.sourceId] = t ? await wikiPlot(t) : ""; sinceSave += 1; }
          failures = 0;
        } catch (e) {
          if (++failures === 5) break;
          await sleep(120000);
          continue;
        }
        if (sinceSave >= 20) { sinceSave = 0; await idbSet("wiki", wikiPlots); catalog.index = indexCatalog(catalog.items); }
      }
      await idbSet("wiki", wikiPlots);
      catalog.index = indexCatalog(catalog.items);
    } finally { wikiRunning = false; }
  }

  async function storySearch(query) {
    if (catalog.state === "failed") {
      if (now() < catalog.retryAt) throw new Error("Couldn't download the story index from MangaDex (" + (catalog.error || "no answer") + "). Try again in a few minutes.");
      catalog.state = "empty";
    }
    if (!catalog.items.length) {
      ensureCatalog().then(() => { if (catalog.items.length) enrichWithWikipedia(); });
      if (!catalog.items.length) return { building: true, done: catalog.done, total: CATALOG_SIZE };
    }
    const [docs, df] = catalog.index, total = docs.length;
    const [ideas, leftover] = queryTerms(query);
    const plain = [...leftover].filter((w) => df.get(w));
    const raw = {}; for (const w of wordsOf(query)) raw[stem(w)] = w;
    const weight = (k, boost = 1) => boost * Math.log(1 + total / ((df.get(k) || 0) + 1));
    const terms = [...ideas].map((i) => [i, weight(i, 1.5), true]).concat(plain.map((w) => [w, weight(w), false]));
    if (!terms.length) return { results: [], terms: 0 };
    const ideaTotal = terms.filter((t) => t[2]).reduce((a, t) => a + t[1], 0);
    const plainTotal = terms.filter((t) => !t[2]).reduce((a, t) => a + t[1], 0);
    const plainScale = ideaTotal && plainTotal ? Math.min(1, ideaTotal / plainTotal) : 1;
    const full = ideaTotal + plainScale * plainTotal;
    const scored = [];
    docs.forEach(([st, id], rank) => {
      let gi = 0, gp = 0;
      for (const [k, w, idea] of terms) if (idea ? id.has(k) : st.has(k)) idea ? (gi += w) : (gp += w);
      const score = (gi + plainScale * gp) / full;
      if (score) scored.push([score, rank]);
    });
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const language = DATA.settings.language || "en", results = [];
    for (const [score, rank] of scored.slice(0, 24)) {
      if (score < 0.2) break;
      const item = catalog.items[rank], [st, id] = docs[rank];
      const has = (k, idea) => (idea ? id.has(k) : st.has(k));
      const label = (k, idea) => (idea ? k : raw[k] || k);
      const { summary, tags, languages, ...rest } = item;
      results.push({ ...rest, match: Math.round(score * 100), matched: terms.filter(([k, , i]) => has(k, i)).map(([k, , i]) => label(k, i)),
        missed: terms.filter(([k, , i]) => !has(k, i)).map(([k, , i]) => label(k, i)), readable: languages.includes(language), wiki: !!wikiPlots[item.sourceId] });
    }
    const vals = Object.values(wikiPlots);
    return { results, terms: terms.length, searched: total, plotsChecked: vals.length, plotsFound: vals.filter(Boolean).length };
  }

  // ------------------------------------------------------------ the api() routes the page calls
  async function handle(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase(), body = opts.body || {};
    const u = new URL(path, "https://app.local"), p = u.pathname.replace(/\/+$/, ""), q = u.searchParams;
    await data();
    let m;
    if (method === "GET") {
      if (p === "/api/library") return { series: DATA.series, settings: DATA.settings, lastCheck: DATA.lastCheck, checking };
      if (p === "/api/history") return DATA.history.slice(0, 500);
      if (p === "/api/events") { const since = +(q.get("since") || 0); return DATA.events.filter((e) => e.ts > since); }
      if (p === "/api/search") return mangadexSearch(q.get("q") || "");
      if (p === "/api/link-preview") return linkPreview((q.get("url") || "").trim());
      if (p === "/api/export") return DATA;
      if ((m = /^\/api\/series\/(\w+)\/chapters$/.exec(p))) {
        const s = findSeries(m[1]); if (!s) throw new Error("not found");
        return { chapters: await seriesChapters(s, q.has("refresh")) };
      }
      if ((m = /^\/api\/chapter\/([0-9a-f-]{36})\/pages$/.exec(p))) return { pages: (await chapterPages(m[1], q.has("refresh"))).map(via) };
      throw new Error("not found");
    }
    if (method === "POST") {
      if (p === "/api/series") {
        if (body.source !== "manual" && DATA.series.some((s) => s.source === body.source && s.sourceId === body.sourceId)) throw new Error("Already in your library");
        const s = { id: newId(), source: body.source || "manual", sourceId: body.sourceId || "", title: body.title || "Untitled", cover: body.cover || null,
          url: body.url || null, readUrl: body.readUrl || "", kind: body.kind || "Comic", status: STATUSES.has(body.status) ? body.status : "reading",
          lastRead: body.lastRead || null, latestChapter: body.latestChapter || null, rating: null, notes: "", favorite: false, tags: [], added: now(), updated: now() };
        DATA.series.unshift(s); addHistory(s, "added"); await save();
        if (s.source !== "manual") runCheck(s.id).catch(() => {});
        return s;
      }
      if ((m = /^\/api\/series\/(\w+)\/read$/.exec(p))) {
        const s = findSeries(m[1]); if (!s) throw new Error("not found");
        const ch = String(body.chapter != null ? body.chapter : s.latestChapter || "");
        if ((s.position || {}).chapter === ch) delete s.position;
        const old = toNum(s.lastRead), nv = toNum(ch);
        if (body.onlyForward && old !== null && (nv === null || nv <= old)) { await save(); return s; }
        s.lastRead = ch; s.updated = now();
        if (s.status === "plan" || s.status === "on-hold") s.status = "reading";
        addHistory(s, "read", ch); await save();
        return s;
      }
      if ((m = /^\/api\/series\/(\w+)\/position$/.exec(p))) {
        const s = findSeries(m[1]); if (!s) throw new Error("not found");
        s.position = { chapterId: body.chapterId, chapter: body.chapter, page: body.page || 0 }; await save();
        return s;
      }
      if (p === "/api/check") return runCheck(body.id);
      if (p === "/api/settings") {
        for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in body) DATA.settings[k] = body[k];
        await save(); scheduleBackground();
        return DATA.settings;
      }
      if (p === "/api/story-search") return storySearch(String(body.q || ""));
      if (p === "/api/test-toast") {
        if (NATIVE) {
          const LN = plugin("LocalNotifications");
          let perm = await LN.checkPermissions();
          if (perm.display !== "granted") perm = await LN.requestPermissions();
          if (perm.display !== "granted") throw new Error("Notifications are blocked. Allow them for Comic Tracker in your phone's settings.");
        } else if (typeof Notification === "undefined") throw new Error("This browser can't show notifications");
        else if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked. Allow them for this app in your phone's settings.");
        const was = DATA.settings.windowsToast; DATA.settings.windowsToast = true;
        await notify("Comic Tracker", "Notifications are working."); DATA.settings.windowsToast = was;
        return { ok: true };
      }
      if (p === "/api/import") {
        if (!Array.isArray(body.series)) throw new Error("Invalid backup file");
        DATA = normalize(body); await save();
        return { ok: true, count: DATA.series.length };
      }
      throw new Error("not found");
    }
    if ((m = /^\/api\/series\/(\w+)$/.exec(p))) {
      const s = findSeries(m[1]); if (!s) throw new Error("not found");
      if (method === "DELETE") { DATA.series.splice(DATA.series.indexOf(s), 1); addHistory(s, "removed"); await save(); return { ok: true }; }
      if (method === "PATCH") {
        const oldStatus = s.status;
        for (const [k, v] of Object.entries(body)) {
          if (EDITABLE.has(k)) { if (k === "status" && !STATUSES.has(v)) continue; s[k] = v; }
          else if (k === "latestChapter" && s.source === "manual") s[k] = v;
        }
        s.updated = now();
        if ("status" in body && body.status !== oldStatus) addHistory(s, "status", null, { status: body.status });
        if ("lastRead" in body) addHistory(s, "read", body.lastRead);
        await save();
        return s;
      }
    }
    throw new Error("not found");
  }

  // ------------------------------------------------------------ background checks
  async function scheduleBackground() {
    // Android Chrome can wake an installed app now and then to check; how often is up to the phone.
    if (NATIVE) return;
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (!reg || !("periodicSync" in reg)) return;
      const perm = await navigator.permissions.query({ name: "periodic-background-sync" }).catch(() => ({ state: "denied" }));
      if (perm.state !== "granted") return;
      await reg.periodicSync.register("ct-check", { minInterval: Math.max(60, DATA.settings.checkIntervalMinutes || 60) * 60000 });
    } catch {}
  }

  root.CT = { handle, runCheck, data, setRelay, relay: () => (NATIVE ? { native: true } : RELAY), native: NATIVE, plugin: NATIVE ? plugin : null, getJson, via, idbGet, idbSet, ensureCatalog, enrichWithWikipedia, scheduleBackground };

  if (!IS_PAGE) return;
  root.CT_BACKEND = handle;
  root.CT_COVER = (u) => (/^https?:/.test(u) && RELAY && !NATIVE ? via(u) : u);

  // MangaDex asks readers to report every image loaded from a MangaDex@Home server.
  // In the Android app reader pages load straight from those servers, so report them here.
  if (NATIVE) {
    const report = (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG") return;
      let u; try { u = new URL(img.currentSrc || img.src); } catch { return; }
      if (!u.hostname.endsWith(".mangadex.network")) return;
      const t = performance.getEntriesByName(u.href).pop();
      plugin("CapacitorHttp").request({
        url: "https://api.mangadex.network/report", method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": APP_UA },
        data: { url: u.href, success: e.type === "load", cached: false, bytes: (t && (t.encodedBodySize || t.transferSize)) || 0, duration: Math.round((t && t.duration) || 0) },
      }).catch(() => {});
    };
    document.addEventListener("load", report, true);
    document.addEventListener("error", report, true);
  }

  // A pairing link (…/#relay=URL&key=KEY) connects this phone; the hash never leaves the phone.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("relay") && hash.get("key")) {
    RELAY = { url: hash.get("relay").replace(/\/+$/, ""), key: hash.get("key") };
    try { localStorage.setItem("ct.relay", JSON.stringify(RELAY)); } catch {}
    setRelay(RELAY);
    history.replaceState(null, "", location.pathname);
  }
  if (RELAY) idbGet("relay").then((r) => { if (!r) idbSet("relay", RELAY); });

  // Check on open, then on schedule while the app is open.
  async function maybeCheck() {
    if ((!RELAY && !NATIVE) || document.hidden) return;
    await data(true);
    const every = Math.max(10, DATA.settings.checkIntervalMinutes || 60) * 60000;
    if (!DATA.lastCheck || now() - DATA.lastCheck >= every) {
      await runCheck().catch(() => {});
      if (root.load) root.load().catch(() => {});
    }
  }
  setTimeout(maybeCheck, 3000);
  setInterval(maybeCheck, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { DATA = null; if (root.load) root.load().catch(() => {}); maybeCheck(); } });
  data().then(scheduleBackground);
  // Keep collecting story plots while the app is open, if the index is already here.
  setTimeout(() => { if (RELAY) idbGet("catalog").then((c) => { if (c) ensureCatalog().then(enrichWithWikipedia); }); }, 20000);
})(self);
