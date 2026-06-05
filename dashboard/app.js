// UNDERLOD telemetry dashboard.
// All client-side. Worker URL + token live in localStorage on this device.
// Never commit a token to the repo — they're paste-on-load only.

const LS_URL = "underlod.worker_url";
const LS_TOKEN = "underlod.token";

// Default worker URL — not a secret (it's in the game binary). Saved
// localStorage value still takes precedence if the user changed it.
const DEFAULT_WORKER_URL = "https://underlod-logging.sdwr.workers.dev";

const $ = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.classList.toggle("error", isError);
}

function loadCreds() {
  $("worker-url").value = localStorage.getItem(LS_URL) || DEFAULT_WORKER_URL;
  $("token").value = localStorage.getItem(LS_TOKEN) || "";
}

function saveCreds() {
  let url = $("worker-url").value.trim().replace(/\/$/, "");
  // auto-prepend https:// if the user pasted a bare hostname
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  $("worker-url").value = url;
  localStorage.setItem(LS_URL, url);
  localStorage.setItem(LS_TOKEN, $("token").value.trim());
}

function clearCreds() {
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_TOKEN);
  $("worker-url").value = DEFAULT_WORKER_URL;
  $("token").value = "";
  $("content").hidden = true;
  $("empty").hidden = false;
  setStatus("forgot credentials.");
}

async function api(path) {
  const base = localStorage.getItem(LS_URL);
  const token = localStorage.getItem(LS_TOKEN);
  if (!base || !token) throw new Error("missing worker URL or token");
  const res = await fetch(base + path, {
    headers: { Authorization: "Bearer " + token },
  });
  if (res.status === 401) throw new Error("unauthorized — check the token");
  if (!res.ok) throw new Error("worker returned " + res.status);
  return res.json();
}

async function loadDays() {
  const sel = $("day");
  try {
    const { days } = await api("/days");
    // keep the (all recent) option, append days
    sel.innerHTML = '<option value="">(all recent)</option>' +
      days.map((d) => `<option value="${d}">${d}</option>`).join("");
  } catch (e) {
    // not fatal — user can still refresh without picking a day
    console.warn("days endpoint failed", e);
  }
}

async function refresh() {
  saveCreds();
  setStatus("loading...");
  const day = $("day").value;
  const qs = day ? `?day=${encodeURIComponent(day)}&limit=200` : "?limit=100";
  let data;
  try {
    data = await api("/events" + qs);
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  setStatus(`${data.event_count} events from ${data.file_count} files${data.truncated ? " (truncated)" : ""}.`);
  render(data.events);
  $("empty").hidden = true;
  $("content").hidden = false;
}

// ============================================================
// Rendering
// ============================================================

function render(events) {
  // ---- top-line stats ----
  const runs = new Set();
  const installs = new Set();
  let crashes = 0, wins = 0, losses = 0;
  for (const e of events) {
    if (e.run) runs.add(e.run);
    if (e.install) installs.add(e.install);
    if (e.type === "crash") crashes++;
    if (e.type === "level_end") {
      const o = e.data?.outcome;
      if (o === "loss") losses++;
      else if (o === "win" || o === "run_complete") wins++;
    }
  }
  $("stat-events").textContent = events.length;
  $("stat-runs").textContent = runs.size;
  $("stat-installs").textContent = installs.size;
  $("stat-crashes").textContent = crashes;
  $("stat-wins").textContent = wins;
  $("stat-losses").textContent = losses;

  // ---- deaths by level ----
  const deathsByLevel = {};
  for (const e of events) {
    if (e.type === "level_end" && e.data?.outcome === "loss") {
      const lv = e.data.level ?? "?";
      deathsByLevel[lv] = (deathsByLevel[lv] || 0) + 1;
    }
  }
  renderBars("chart-deaths", deathsByLevel, { sortKey: "key-num" });

  // ---- win/loss by level (stacked) ----
  const winLossByLevel = {};
  for (const e of events) {
    if (e.type !== "level_end") continue;
    const lv = e.data?.level ?? "?";
    const o = e.data?.outcome;
    if (!winLossByLevel[lv]) winLossByLevel[lv] = { win: 0, loss: 0 };
    if (o === "loss") winLossByLevel[lv].loss++;
    else if (o === "win" || o === "run_complete") winLossByLevel[lv].win++;
  }
  renderStacked("chart-winloss", winLossByLevel);

  // ---- item popularity (from buy_screen_end snapshots) ----
  const itemCount = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    const units = e.data?.units || [];
    for (const u of units) {
      const items = u.items || [];
      for (const it of items) {
        if (it && it !== "") itemCount[it] = (itemCount[it] || 0) + 1;
      }
    }
  }
  renderBars("chart-items", itemCount, { sortKey: "value-desc", limit: 25 });

  // ---- meta color totals ----
  // sum item counts per color across all buy_screen_end events (we have
  // the per-color counts inline as meta.colors).
  const colorTotals = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    const colors = e.data && e.data.meta && e.data.meta.colors;
    if (!colors) continue;
    for (const k of Object.keys(colors)) {
      colorTotals[k] = (colorTotals[k] || 0) + Number(colors[k] || 0);
    }
  }
  renderBars("chart-colors", colorTotals, { sortKey: "value-desc" });

  // ---- meta tiers reached ----
  // count how many buy_screen_end snapshots had each (color, tier) active.
  const tierCounts = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    const tiers = e.data && e.data.meta && e.data.meta.tiers;
    if (!tiers) continue;
    for (const color of Object.keys(tiers)) {
      const tier = Number(tiers[color] || 0);
      if (tier > 0) {
        const key = color + " T" + tier;
        tierCounts[key] = (tierCounts[key] || 0) + 1;
      }
    }
  }
  renderBars("chart-tiers", tierCounts, { sortKey: "value-desc" });

  // ---- character pick rate ----
  const charCount = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    for (const u of e.data?.units || []) {
      if (u.character) charCount[u.character] = (charCount[u.character] || 0) + 1;
    }
  }
  renderBars("chart-chars", charCount, { sortKey: "value-desc", limit: 25 });

  // ---- recent crashes ----
  const crashEl = $("crashes");
  crashEl.innerHTML = "";
  const crashEvents = events.filter((e) => e.type === "crash").slice(0, 25);
  if (crashEvents.length === 0) {
    crashEl.innerHTML = '<div class="muted">no crashes in this slice.</div>';
  } else {
    for (const c of crashEvents) {
      const div = document.createElement("div");
      div.className = "crash";
      div.innerHTML = `
        <div class="meta">${escapeHtml(c.time)} · ${escapeHtml(c.os || "?")} · love ${escapeHtml(c.love_version || "?")} · v${escapeHtml(c.version || "?")}</div>
        <pre>${escapeHtml(c.data?.message || "")}\n\n${escapeHtml(c.data?.traceback || "")}</pre>
      `;
      crashEl.appendChild(div);
    }
  }

  // ---- raw events ----
  $("raw").textContent = events.slice(0, 50).map((e) => JSON.stringify(e)).join("\n");
}

function renderBars(elId, counts, opts = {}) {
  const el = $(elId);
  el.innerHTML = "";
  let entries = Object.entries(counts);
  if (entries.length === 0) {
    el.innerHTML = '<div class="muted">no data.</div>';
    return;
  }
  if (opts.sortKey === "key-num") {
    entries.sort((a, b) => Number(a[0]) - Number(b[0]));
  } else if (opts.sortKey === "value-desc") {
    entries.sort((a, b) => b[1] - a[1]);
  }
  if (opts.limit) entries = entries.slice(0, opts.limit);
  const max = Math.max(...entries.map((e) => e[1])) || 1;
  for (const [k, v] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="lbl">${escapeHtml(String(k))}</span>
      <span class="bar"><span style="width:${(100 * v / max).toFixed(1)}%"></span></span>
      <span class="val">${v}</span>
    `;
    el.appendChild(row);
  }
}

function renderStacked(elId, byLevel) {
  const el = $(elId);
  el.innerHTML = "";
  const entries = Object.entries(byLevel).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.length === 0) {
    el.innerHTML = '<div class="muted">no data.</div>';
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v.win + v.loss)) || 1;
  for (const [lv, v] of entries) {
    const total = v.win + v.loss;
    const row = document.createElement("div");
    row.className = "bar-row";
    const winPct = (100 * v.win / max).toFixed(1);
    const lossPct = (100 * v.loss / max).toFixed(1);
    row.innerHTML = `
      <span class="lbl">L${escapeHtml(String(lv))}</span>
      <span class="bar stacked">
        <span class="win"  style="width:${winPct}%" title="${v.win} wins"></span>
        <span class="loss" style="width:${lossPct}%" title="${v.loss} losses"></span>
      </span>
      <span class="val">${v.win}/${total}</span>
    `;
    el.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  $("refresh").addEventListener("click", refresh);
  $("logout").addEventListener("click", clearCreds);
  $("day").addEventListener("change", refresh);

  if (localStorage.getItem(LS_URL) && localStorage.getItem(LS_TOKEN)) {
    loadDays().then(refresh);
  }
});
