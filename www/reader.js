// Chapter list and reader screens. Shared by index.html and demo.html; relies on their
// api, esc, num, flash, coverEl, load, lsGet and lsSet helpers.
(() => {
  const css = `
  .rd-screen { position: fixed; inset: 0; z-index: 15; background: var(--bg); color: var(--text); overflow-y: auto; overscroll-behavior: contain; }
  .rd-head { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--border);
    padding: calc(8px + env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px)); }
  .rd-bar { max-width: 1180px; margin: 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .rd-bar select { max-width: 200px; }
  .rd-name { font-weight: 700; min-width: 0; flex: 1 1 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rd-wrap { max-width: 820px; margin: 0 auto; padding: 16px max(16px, env(safe-area-inset-right, 0px)) 48px max(16px, env(safe-area-inset-left, 0px)); }
  .rd-top { display: flex; gap: 14px; margin-bottom: 14px; }
  .rd-top > div:last-child { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .rd-top .btn { align-self: flex-start; text-decoration: none; white-space: normal; }
  .rd-end .btn { text-decoration: none; }
  .rd-top h2 { margin: 0; font-size: 20px; line-height: 1.2; text-wrap: balance; }
  .rd-list { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); }
  .rd-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 0; border-top: 1px solid var(--border); }
  .rd-row:first-child { border-top: 0; }
  .rd-open { flex: 1; min-width: 0; display: block; padding: 7px 4px 7px 14px; background: none; border: 0; color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer; }
  .rd-open:hover b { color: var(--accent); }
  .rd-open small { display: block; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rd-row.read .rd-open b { color: var(--muted); font-weight: 400; }
  .rd-note { color: var(--muted); font-size: 13.5px; margin: 0 0 12px; }
  .rd-body { min-height: 60vh; }
  .rd-strip img { display: block; width: 100%; max-width: 820px; margin: 0 auto; min-height: 40vh; }
  .rd-strip img[data-done] { min-height: 0; }
  .rd-page { position: relative; display: flex; justify-content: center; cursor: pointer; user-select: none; }
  .rd-page img { display: block; max-width: 100%; max-height: calc(100vh - 64px); object-fit: contain; }
  .rd-broken { min-height: 120px !important; padding: 40px 16px; color: var(--muted); text-align: center; cursor: pointer; }
  .rd-end { max-width: 520px; margin: 0 auto; padding: 40px 16px 64px; display: grid; gap: 10px; justify-items: center; text-align: center; }
  .rd-end b { font-size: 18px; }
  .rd-end a:not(.btn) { color: inherit; }
  .rd-msg { padding: 60px 16px; text-align: center; color: var(--muted); display: grid; gap: 12px; justify-items: center; }
  @media (max-width: 560px) { .rd-row .rd-mark { display: none; } .rd-bar select { max-width: 130px; } }`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
  document.body.insertAdjacentHTML("beforeend", `
  <div class="rd-screen" id="rdList" hidden></div>
  <div class="rd-screen" id="rdView" hidden>
    <div class="rd-head"><div class="rd-bar">
      <button class="btn small" id="rdBack">Chapters</button>
      <span class="rd-name" id="rdName"></span>
      <span class="meta" id="rdCount"></span>
      <button class="btn small" id="rdPrev" aria-label="Previous chapter">Prev</button>
      <select id="rdSelect" aria-label="Chapter"></select>
      <button class="btn small" id="rdNext" aria-label="Next chapter">Next</button>
      <button class="btn small" id="rdMode"></button>
      <button class="btn small" id="rdDir"></button>
    </div></div>
    <div class="rd-body" id="rdBody"></div>
  </div>`);

  const el = (id) => document.getElementById(id);
  const R = { series: null, chapters: [], newestFirst: true, query: "", i: 0, page: 0, pages: [], finished: false, token: 0, observer: null, saveTimer: null, pin: null };
  const chName = (c) => (c.chapter == null ? "Oneshot" : "Ch. " + c.chapter);
  const isRead = (c) => { const n = num(c.chapter), last = num(R.series.lastRead); return n !== null && last !== null && n <= last; };
  const stripDefault = (kind) => (kind === "Manga" ? "page" : "strip");
  const mode = () => lsGet("ct.mode." + R.series.kind, stripDefault(R.series.kind));
  const rtl = () => lsGet("ct.dir." + R.series.kind, R.series.kind === "Manga" ? "rtl" : "ltr") === "rtl";
  const lockPage = () => { document.body.style.overflow = el("rdList").hidden && el("rdView").hidden ? "" : "hidden"; };

  // ---- chapter list
  window.openChapters = async (series) => {
    Object.assign(R, { series, chapters: [], query: "" });
    el("rdList").hidden = false; lockPage();
    el("rdList").innerHTML = `<div class="rd-msg">Loading chapters…</div>`;
    try { R.chapters = (await api(`/api/series/${series.id}/chapters`)).chapters; renderList(); }
    catch (err) {
      el("rdList").innerHTML = `<div class="rd-msg"><span>Couldn't load chapters: ${esc(err.message)}</span>
        <div class="row"><button class="btn" data-rd="retry">Try again</button><button class="btn" data-rd="close">Back to library</button></div></div>`;
    }
  };

  function startPoint() {
    const s = R.series, list = R.chapters, pos = s.position;
    if (pos) { const i = list.findIndex((c) => c.id === pos.chapterId); if (i >= 0) return { i, page: pos.page || 0, label: `Continue ${chName(list[i])}, page ${(pos.page || 0) + 1}` }; }
    const i = list.findIndex((c) => num(c.chapter) !== null && !isRead(c));
    if (i >= 0) return { i, page: 0, label: num(s.lastRead) === null ? `Start at ${chName(list[i])}` : `Continue with ${chName(list[i])}` };
    return list.length ? { i: list.length - 1, page: 0, label: "Reread latest chapter" } : null;
  }

  const openLink = (c, i, cls, inner) => (c.external
    ? `<a class="${cls}" href="${esc(c.url)}" target="_blank" rel="noopener" data-ext="${i}">${inner}</a>`
    : `<button class="${cls}" data-go="${i}">${inner}</button>`);

  function rowsHtml() {
    const q = R.query.trim().toLowerCase(), pos = R.series.position;
    const rows = R.chapters.map((c, i) => [c, i]).filter(([c]) => !q || `${c.chapter} ${c.title}`.toLowerCase().includes(q));
    if (R.newestFirst) rows.reverse();
    if (!rows.length) return `<div class="rd-msg">No chapter matches that.</div>`;
    return rows.map(([c, i]) => {
      const detail = [c.title, c.group, c.pages ? c.pages + " pages" : ""].filter(Boolean).join(" · ");
      const tags = [pos && pos.chapterId === c.id ? `<span class="tag new">Page ${(pos.page || 0) + 1}</span>` : "",
        isRead(c) ? `<span class="tag done">Read</span>` : "", c.external ? `<span class="tag">Opens on ${esc(c.site)}</span>` : ""].join("");
      return `<div class="rd-row ${isRead(c) ? "read" : ""}">
        ${openLink(c, i, "rd-open", `<b>${esc(chName(c))}</b><small>${esc(detail) || "&nbsp;"}</small>`)}
        ${tags}
        ${c.chapter != null ? `<button class="btn small rd-mark" data-mark="${i}">Read up to here</button>` : ""}
      </div>`;
    }).join("");
  }

  function renderList() {
    const s = R.series, start = startPoint(), list = R.chapters;
    const anyExternal = list.some((c) => c.external), allExternal = list.length && list.every((c) => c.external);
    const note = !list.length ? (s.source === "mangadex" ? "No chapters in your chosen language on MangaDex. Change the language in Settings, or pick another entry for this series." : "This page shows no chapter links right now.")
      : allExternal ? `These chapters open on ${esc(list[0].site)} in a new tab. Opening one marks it as read here.${s.source === "rss" ? " Feeds only list the newest episodes." : ""}`
      : anyExternal ? "Chapters marked “Opens on” are hosted elsewhere and open in a new tab." : "";
    el("rdList").innerHTML = `
      <div class="rd-head"><div class="rd-bar"><button class="btn small" data-rd="close">Library</button></div></div>
      <div class="rd-wrap">
        <div class="rd-top">${coverEl(s)}<div>
          <h2>${esc(s.title)}</h2>
          <div class="meta">Read ${esc(s.lastRead ?? "–")} / latest ${esc(s.latestChapter ?? "?")} · ${list.length} chapters</div>
          ${start ? openLink(list[start.i], start.i, "btn primary", esc(start.label)).replace("data-go=", `data-page="${start.page}" data-go=`) : ""}
        </div></div>
        ${note ? `<p class="rd-note">${note}</p>` : ""}
        ${list.length ? `<div class="toolbar">
          <input type="search" id="rdFind" placeholder="Find a chapter…" aria-label="Find a chapter" value="${esc(R.query)}">
          <button class="btn" data-rd="order">${R.newestFirst ? "Newest first" : "Oldest first"}</button>
        </div>
        <div class="rd-list" id="rdRows">${rowsHtml()}</div>` : ""}
      </div>`;
  }

  async function markRead(c, onlyForward) {
    try {
      R.series = await api(`/api/series/${R.series.id}/read`, { method: "POST", body: { chapter: String(c.chapter), onlyForward } });
      load();
    } catch (err) { flash(err.message); }
  }

  el("rdList").addEventListener("input", (e) => { if (e.target.id === "rdFind") { R.query = e.target.value; el("rdRows").innerHTML = rowsHtml(); } });
  el("rdList").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-rd],[data-go],[data-mark],[data-ext]"); if (!t) return;
    if (t.dataset.rd === "close") return closeAll();
    if (t.dataset.rd === "retry") return window.openChapters(R.series);
    if (t.dataset.rd === "order") { R.newestFirst = !R.newestFirst; return renderList(); }
    if (t.dataset.go !== undefined) return openChapter(+t.dataset.go, +(t.dataset.page || 0));
    if (t.dataset.mark !== undefined) { const c = R.chapters[+t.dataset.mark]; await markRead(c, false); flash(`Progress set to ${chName(c)}`); return renderList(); }
    if (t.dataset.ext !== undefined) { const c = R.chapters[+t.dataset.ext]; if (c.chapter != null) { await markRead(c, true); renderList(); } }
  });

  function closeAll() { el("rdList").hidden = true; el("rdView").hidden = true; lockPage(); load(); }

  // ---- reader
  async function openChapter(i, page = 0) {
    const c = R.chapters[i]; if (!c) return;
    if (c.external) { window.open(c.url, "_blank", "noopener"); if (c.chapter != null) markRead(c, true); return; }
    flushPosition(); stopWatching();
    const token = ++R.token;
    Object.assign(R, { i, page, pages: [], finished: false, pin: page > 0 ? page : null });
    el("rdView").hidden = false; lockPage(); el("rdView").scrollTop = 0;
    el("rdName").textContent = `${R.series.title} · ${chName(c)}`;
    el("rdSelect").innerHTML = R.chapters.map((x, n) => `<option value="${n}" ${n === i ? "selected" : ""}>${esc(chName(x))}</option>`).join("");
    el("rdPrev").disabled = i === 0; el("rdNext").disabled = i === R.chapters.length - 1;
    el("rdCount").textContent = "";
    el("rdBody").innerHTML = `<div class="rd-msg">Loading pages…</div>`;
    try {
      const d = await api(`/api/chapter/${c.id}/pages`);
      if (token !== R.token) return;
      R.pages = d.pages; R.page = Math.min(page, R.pages.length - 1);
      render();
    } catch (err) {
      if (token !== R.token) return;
      el("rdBody").innerHTML = `<div class="rd-msg"><span>Couldn't load this chapter: ${esc(err.message)}</span><button class="btn" id="rdRetry">Try again</button></div>`;
      el("rdRetry").onclick = () => openChapter(i, page);
    }
  }

  function setCount() {
    el("rdCount").textContent = R.page >= R.pages.length ? "Finished" : `Page ${R.page + 1} / ${R.pages.length}`;
  }

  function stopWatching() {
    if (R.observer) R.observer.disconnect();
    if (R.endObserver) R.endObserver.disconnect();
  }

  function render() {
    stopWatching();
    const strip = mode() === "strip";
    el("rdMode").textContent = strip ? "Long strip" : "Single page";
    el("rdDir").hidden = strip;
    el("rdDir").textContent = rtl() ? "Right to left" : "Left to right";
    strip ? renderStrip() : showPage(R.page);
  }

  function watchImage(img, i) {
    img.addEventListener("load", () => {
      img.dataset.done = "1";
      if (R.pin !== null && i <= R.pin) { const target = el("rdBody").querySelectorAll("img")[R.pin]; if (target) target.scrollIntoView({ block: "start" }); }
    });
    img.addEventListener("error", async () => {
      if (!img.dataset.retried) { // the image server may have gone bad; ask MangaDex for a new one
        img.dataset.retried = "1";
        try { R.pages = (await api(`/api/chapter/${R.chapters[R.i].id}/pages?refresh=1`)).pages; img.src = R.pages[i]; return; } catch {}
      }
      img.alt = `Page ${i + 1} didn't load. Click to try again.`; img.classList.add("rd-broken");
      img.onclick = (e) => { e.stopPropagation(); img.onclick = null; delete img.dataset.retried; img.classList.remove("rd-broken"); img.src = R.pages[i] + "&r=" + Date.now(); };
    });
  }

  function renderStrip() {
    const body = el("rdBody");
    body.innerHTML = `<div class="rd-strip">${R.pages.map((p, i) => `<img loading="${Math.abs(i - R.page) < 3 ? "eager" : "lazy"}" src="${esc(p)}" alt="Page ${i + 1}">`).join("")}</div>${endPanel()}`;
    const imgs = [...body.querySelectorAll("img")];
    imgs.forEach(watchImage);
    if (R.page > 0) imgs[R.page].scrollIntoView({ block: "start" });
    // The page crossing the middle of the screen counts as the current page.
    R.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        R.page = imgs.indexOf(en.target); setCount(); queuePosition();
      }
    }, { root: el("rdView"), rootMargin: "-50% 0px -50% 0px" });
    imgs.forEach((im) => R.observer.observe(im));
    // The end panel sits at the bottom of the screen, so it never reaches the middle line above.
    R.endObserver = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) finish(); }, { root: el("rdView") });
    R.endObserver.observe(body.querySelector(".rd-end"));
    setCount();
  }

  function showPage(p) {
    p = Math.max(0, Math.min(p, R.pages.length));
    R.page = p; el("rdView").scrollTop = 0;
    if (p >= R.pages.length) { el("rdBody").innerHTML = endPanel(); finish(); setCount(); return; }
    el("rdBody").innerHTML = `<div class="rd-page"><img src="${esc(R.pages[p])}" alt="Page ${p + 1}"></div>`;
    watchImage(el("rdBody").querySelector("img"), p);
    for (const n of [p + 1, p + 2]) if (R.pages[n]) new Image().src = R.pages[n];
    setCount(); queuePosition();
  }

  const turn = (forward) => showPage(R.page + (forward ? 1 : -1));

  function endPanel() {
    const c = R.chapters[R.i], next = R.chapters[R.i + 1];
    return `<div class="rd-end"><b>End of ${esc(chName(c))}</b>
      ${next ? openLink(next, R.i + 1, "btn primary", `Next: ${esc(chName(next))}`) : `<span class="meta">You've reached the latest chapter.</span>`}
      <button class="btn" data-end="list">Back to chapters</button>
      <span class="meta">Scanlation: ${esc(c.group || "No group credited")} · Hosted by <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.site)}</a></span></div>`;
  }

  function finish() {
    if (R.finished) return;
    R.finished = true; clearTimeout(R.saveTimer); R.saveTimer = null;
    el("rdCount").textContent = "Finished";
    const c = R.chapters[R.i]; if (c.chapter == null) return;
    const ahead = !isRead(c);
    markRead(c, true).then(() => { if (ahead) flash(`${chName(c)} marked as read`); });
  }

  function queuePosition() {
    clearTimeout(R.saveTimer);
    if (R.finished || R.page === 0) { R.saveTimer = null; return; }
    R.saveTimer = setTimeout(flushPosition, 1500);
  }

  function flushPosition() {
    if (!R.saveTimer) return;
    clearTimeout(R.saveTimer); R.saveTimer = null;
    const c = R.chapters[R.i], position = { chapterId: c.id, chapter: c.chapter, page: R.page };
    R.series.position = position;
    api(`/api/series/${R.series.id}/position`, { method: "POST", body: position }).catch(() => {});
  }

  function leaveReader() {
    flushPosition(); R.token++;
    stopWatching();
    el("rdView").hidden = true; el("rdBody").innerHTML = ""; lockPage();
    if (!el("rdList").hidden) renderList();
  }

  el("rdBack").onclick = leaveReader;
  el("rdPrev").onclick = () => openChapter(R.i - 1);
  el("rdNext").onclick = () => openChapter(R.i + 1);
  el("rdSelect").onchange = (e) => openChapter(+e.target.value);
  el("rdMode").onclick = () => { lsSet("ct.mode." + R.series.kind, mode() === "strip" ? "page" : "strip"); R.page = Math.min(R.page, R.pages.length - 1); render(); };
  el("rdDir").onclick = () => { lsSet("ct.dir." + R.series.kind, rtl() ? "ltr" : "rtl"); render(); };
  el("rdBody").addEventListener("click", (e) => {
    const end = e.target.closest("[data-go],[data-end],[data-ext]");
    if (end) {
      if (end.dataset.go !== undefined) openChapter(+end.dataset.go);
      else if (end.dataset.end) leaveReader();
      else { const c = R.chapters[+end.dataset.ext]; if (c.chapter != null) markRead(c, true); }
      return;
    }
    const box = e.target.closest(".rd-page"); if (!box) return;
    const rect = box.getBoundingClientRect(), rightSide = e.clientX > rect.left + rect.width / 2;
    turn(rightSide !== rtl());
  });
  for (const ev of ["wheel", "touchstart", "keydown"]) el("rdView").addEventListener(ev, () => { R.pin = null; }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("rdView").hidden) return leaveReader();
    if (e.key === "Escape" && !el("rdList").hidden) return closeAll();
    if (el("rdView").hidden || e.target.matches("input, select, textarea") || !R.pages.length) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    R.pin = null;
    const right = e.key === "ArrowRight";
    if (mode() === "strip") openChapter(R.i + (right ? 1 : -1)); else turn(right !== rtl());
  });
})();
