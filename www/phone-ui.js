// Phone-app changes to the shared page: connection setup, phone wording, install button.
(function () {
  const $ = (s) => document.querySelector(s);
  const css = document.createElement("style");
  css.textContent = `
    body { padding-bottom: env(safe-area-inset-bottom, 0px); }
    header { padding-top: env(safe-area-inset-top, 0px); }
    .ct-banner { margin: 0 0 14px; padding: 12px 14px; border-radius: 10px; background: var(--accent, #ff7a3d); color: #fff; }
    .ct-banner b { color: #fff; }
    .ct-banner .btn { margin-top: 8px; background: #fff; color: #222; border: 0; }
    .ct-ok { color: #3fb950; font-weight: 600; }
    .ct-bad { color: #f85149; font-weight: 600; }`;
  document.head.appendChild(css);

  const NATIVE = !!CT.native;

  const settings = $("#tab-settings");
  // ---- connection panel at the top of Settings (web app only; the Android app needs no relay)
  if (!NATIVE) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h2>Connection</h2>
    <p>The app reaches MangaDex, Webtoons and reading sites through your own relay on Cloudflare, because those sites don't let web apps load them directly.</p>
    <p id="ctConnState"></p>
    <form class="form" id="ctConnForm">
      <label>Relay address<input name="url" type="url" placeholder="https://comic-relay.your-name.workers.dev" autocomplete="off"></label>
      <label>Relay key<input name="key" autocomplete="off" spellcheck="false"></label>
      <div class="row"><button class="btn primary">Save and test</button></div>
    </form>
    <p class="meta">Tip: opening your pairing link fills these in for you.</p>`;
  settings.prepend(panel);
  const form = $("#ctConnForm");
  function showConn() {
    const r = CT.relay();
    form.url.value = r ? r.url : ""; form.key.value = r ? r.key : "";
    $("#ctConnState").innerHTML = r ? `<span class="ct-ok">Connected</span>` : `<span class="ct-bad">Not connected yet</span>`;
    banner.hidden = !!r;
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = form.url.value.trim(), key = form.key.value.trim();
    if (!url || !key) return flash("Enter both the relay address and key");
    await CT.setRelay({ url, key });
    $("#ctConnState").textContent = "Testing…";
    try {
      const res = await fetch(CT.via("https://api.mangadex.org/ping"));
      const text = await res.text();
      if (!res.ok) throw new Error(res.status === 403 ? "The key is wrong" : "The relay answered " + res.status);
      $("#ctConnState").innerHTML = `<span class="ct-ok">Connected.</span> MangaDex answered: ${text.trim().slice(0, 20)}`;
      banner.hidden = true;
      load().catch(() => {});
    } catch (err) {
      $("#ctConnState").innerHTML = `<span class="ct-bad">Not working:</span> ${String(err.message).includes("fetch") ? "couldn't reach that address" : err.message}`;
    }
  });

  // ---- banner on every tab until connected
  const banner = document.createElement("div");
  banner.className = "ct-banner";
  banner.innerHTML = `<b>Almost ready.</b> Open your pairing link on this phone, or enter your relay details in Settings, so the app can check for chapters.<br><button class="btn small" type="button">Open Settings</button>`;
  banner.querySelector("button").onclick = () => document.querySelector('#nav [data-tab="settings"]').click();
  $("main").prepend(banner);
  showConn();
  }

  // ---- phone wording in Settings
  const upd = [...settings.querySelectorAll(".panel")].find((p) => p.querySelector('input[name="windowsToast"]'));
  upd.querySelector("p").textContent = NATIVE ? "The app checks for new chapters when you open it and on schedule while it's open." : "The app checks when you open it and on schedule while it's open. On Android, the installed app may also check in the background a few times a day; how often is up to your phone.";
  const toastBox = upd.querySelector('input[name="windowsToast"]');
  toastBox.parentElement.lastChild.textContent = " Notify me about new chapters";
  toastBox.addEventListener("change", () => { if (NATIVE) { if (toastBox.checked) CT.plugin("LocalNotifications").requestPermissions().catch(() => {}); return; } if (toastBox.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission(); });
  $("#browserNotif").style.display = "none"; // the page still updates its label, so hide it rather than remove it
  const test = $("#testToast"), fresh = test.cloneNode(true); // drop the PC wording
  test.replaceWith(fresh);
  fresh.addEventListener("click", async () => { try { await api("/api/test-toast", { method: "POST", body: {} }); flash("Sent. Check your notifications."); } catch (err) { flash(err.message); } });
  const backup = [...settings.querySelectorAll(".panel h2")].find((h) => h.textContent === "Backup").parentElement;
  backup.querySelector("p").textContent = "Your library is saved on this phone only. Export a backup now and then. To bring over your PC library, use Export backup in the PC app, send the file to your phone, and import it here.";
  const credit = document.createElement("p");
  credit.className = "meta";
  credit.innerHTML = `Chapters and covers from <a href="https://mangadex.org" target="_blank" rel="noopener">MangaDex</a> and its scanlation groups. Story search plots from <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA 4.0).`;
  backup.after(Object.assign(document.createElement("div"), { className: "panel" })); backup.nextSibling.appendChild(credit);

  if (NATIVE) androidApp(settings, backup);

  // ---- install button (Android Chrome)
  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferred = e;
    if ($("#ctInstall")) return;
    const b = Object.assign(document.createElement("button"), { id: "ctInstall", className: "btn small primary", type: "button", textContent: "Install app" });
    b.onclick = async () => { deferred.prompt(); await deferred.userChoice; deferred = null; b.remove(); };
    $("header .bar").appendChild(b);
  });

  // ---- a notification opens the Updates tab
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data && e.data.tab) { load().catch(() => {}); document.querySelector(`#nav [data-tab="${e.data.tab}"]`)?.click(); }
  });
  if (new URLSearchParams(location.search).get("tab") === "updates") {
    document.querySelector('#nav [data-tab="updates"]')?.click();
    history.replaceState(null, "", location.pathname);
  }

  // ---- Android app only: back button, notification taps, backup sharing, app updates
  function androidApp(settings, backup) {
    const P = CT.plugin;
    const tab = (name) => document.querySelector(`#nav [data-tab="${name}"]`)?.click();
    P("App").addListener("backButton", () => {
      const view = $("#rdView"), list = $("#rdList"), dlg = document.querySelector("dialog[open]");
      if (dlg) return dlg.close();
      if (view && !view.hidden) return $("#rdBack").click();
      if (list && !list.hidden) return list.querySelector('[data-rd="close"]')?.click();
      if (!document.querySelector('#nav [data-tab="library"]').classList.contains("on")) return tab("library");
      P("App").minimizeApp().catch(() => P("App").exitApp());
    });
    P("App").addListener("resume", () => { load().catch(() => {}); });
    P("LocalNotifications").addListener("localNotificationActionPerformed", () => { load().catch(() => {}); tab("updates"); });

    // a web download doesn't work inside the app, so save the file and open the share sheet
    const exp = $("#exportBtn"), fresh = exp.cloneNode(true);
    exp.replaceWith(fresh);
    fresh.addEventListener("click", async () => {
      try {
        const d = await api("/api/export");
        const name = `comic-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
        const w = await P("Filesystem").writeFile({ path: name, data: JSON.stringify(d, null, 2), directory: "CACHE", encoding: "utf8" });
        await P("Share").share({ title: "Comic Tracker backup", files: [w.uri] });
      } catch (err) { if (!/cancel/i.test(err.message || "")) flash(err.message || "Couldn't export"); }
    });
    backup.querySelector("p").textContent = "Your library is saved in this app only. Export a backup now and then (you can save it to Drive or Files). To bring over your PC library, use Export backup in the PC app, send the file to your phone, and import it here.";

    // app version and updates
    const REPO = "Al3nafk/comic-tracker-android", build = +(window.CT_BUILD || 0);
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `<h2>App</h2><p>Comic Tracker for Android, version ${build ? "1." + build : "dev"}.</p>
      <p id="ctUpd" class="meta"></p>
      <div class="row"><button class="btn" type="button" id="ctUpdBtn">Check for an update</button></div>`;
    settings.appendChild(panel);
    async function checkUpdate(quiet) {
      const out = $("#ctUpd");
      if (!quiet) out.textContent = "Checking…";
      try {
        const r = await CT.getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
        const latest = +String(r.tag_name || "").replace(/^v1\./, "") || 0;
        if (latest > build) {
          out.innerHTML = `Version 1.${latest} is out. <a href="https://github.com/${REPO}/releases/latest/download/ComicTracker.apk" target="_blank" rel="noopener">Download it</a>, open the file, and tap Update. Your library stays.`;
          if (quiet) flash("A new version of the app is out. See Settings → App.");
        } else if (!quiet) out.textContent = "You have the latest version.";
      } catch (err) { if (!quiet) out.textContent = / 404$/.test(err.message) ? "You have the latest version." : "Couldn't check: " + err.message; }
    }
    $("#ctUpdBtn").onclick = () => checkUpdate(false);
    setTimeout(() => checkUpdate(true), 8000);
  }
})();
