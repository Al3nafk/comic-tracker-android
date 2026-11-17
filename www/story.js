// "Find a comic by its story" panel on the Add page. Shared by index.html and demo.html;
// relies on their api, esc, flash, coverEl, load and lib.
(() => {
  document.head.insertAdjacentHTML("beforeend", `<style>
  #storyQ { width: 100%; min-height: 84px; }
  .st-match { display: flex; align-items: center; gap: 8px; }
  .st-match b { font-size: 18px; color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .st-meter { flex: 1; height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; min-width: 40px; }
  .st-meter i { display: block; height: 100%; background: var(--accent); }
  .st-why { font-size: 12.5px; color: var(--muted); }
  .st-why b { color: var(--text); font-weight: 600; }
  .st-sum { font-size: 13px; color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  </style>`);
  document.getElementById("tab-add").insertAdjacentHTML("afterbegin", `
  <div class="panel">
    <h2>Find a comic by its story</h2>
    <p>Describe the plot in your own words, as much as you remember. Each result's percentage shows how much of what you described appears in that series' summary, tags and Wikipedia plot, if it has one.</p>
    <form class="form" id="storyForm">
      <textarea id="storyQ" required aria-label="Describe the story" placeholder="e.g. The weakest hunter gets a secret system and levels up alone while fighting monsters"></textarea>
      <div><button class="btn primary" id="storyBtn">Find matches</button></div>
    </form>
    <div class="meta" id="storyNote" style="margin-top:10px" role="status"></div>
    <div class="grid" id="storyResults" style="margin-top:12px"></div>
  </div>`);

  const box = document.getElementById("storyResults"), note = document.getElementById("storyNote"), btn = document.getElementById("storyBtn");
  let results = [], waiting = null;

  const resultHtml = (r, i) => `<div class="card">${coverEl(r)}
    <div class="info">
      <div class="title">${esc(r.title)}</div>
      <div class="st-match"><b>${r.match}% match</b><span class="st-meter"><i style="width:${r.match}%"></i></span></div>
      <div class="row"><span class="tag">${esc(r.kind)}</span>${r.status ? `<span class="tag">${esc(r.status)}</span>` : ""}${r.year ? `<span class="tag">${r.year}</span>` : ""}
        ${r.readable === false ? `<span class="tag">No chapters in your language</span>` : ""}
        ${r.wiki ? `<span class="tag">Plot from Wikipedia</span>` : ""}</div>
      ${r.matched.length ? `<div class="st-why"><b>Matches:</b> ${esc(r.matched.join(", "))}</div>` : ""}
      ${r.missed.length ? `<div class="st-why"><b>Not mentioned:</b> ${esc(r.missed.join(", "))}</div>` : ""}
      <div class="st-sum">${esc(r.description || "")}</div>
      <div class="row" style="margin-top:auto">${lib.series.some((s) => s.sourceId === r.sourceId) ? `<span class="tag done">In library</span>` :
        `<button class="btn small primary" data-story="${i}" data-st="reading">Add · reading</button><button class="btn small" data-story="${i}" data-st="plan">Plan to read</button>`}
        ${r.url && r.url !== "#" ? `<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noopener">View</a>` : ""}</div>
    </div></div>`;

  async function search() {
    clearTimeout(waiting);
    btn.disabled = true; box.innerHTML = ""; note.textContent = "Comparing your description…";
    try {
      const d = await api("/api/story-search", { method: "POST", body: { q: document.getElementById("storyQ").value } });
      if (d.building) { // first run only: the summaries are still downloading
        note.textContent = `Preparing the story index for first use: ${d.done.toLocaleString()} of ${d.total.toLocaleString()} series. Results will appear here when it's ready.`;
        waiting = setTimeout(search, 3000);
        return;
      }
      results = d.results;
      box.innerHTML = results.map(resultHtml).join("");
      if (!results.length) note.textContent = "No close matches. Try different words, or describe more of the plot.";
      else if (d.terms < 3) note.textContent = "Only a few details to compare, so these results are rough. Add more of the plot for better matches.";
      else note.textContent = `Top ${results.length} of ${d.searched.toLocaleString()} series compared.`;
    } catch (err) { note.textContent = `Search failed: ${err.message}`; }
    btn.disabled = false;
  }

  document.getElementById("storyForm").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-story]"); if (!b) return;
    const r = results[+b.dataset.story]; b.disabled = true;
    try {
      await api("/api/series", { method: "POST", body: { ...r, status: b.dataset.st } });
      flash(`Added ${r.title}`); await load();
      const row = b.closest(".row");
      row.querySelectorAll("[data-story]").forEach((x) => x.remove());
      row.insertAdjacentHTML("afterbegin", `<span class="tag done">In library</span>`);
    } catch (err) { flash(err.message); b.disabled = false; }
  });
})();
