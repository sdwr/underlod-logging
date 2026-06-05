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
    // server returns [{day, count}] — keep the (all recent) option, append days
    sel.innerHTML = '<option value="">(all recent)</option>' +
      days.map((d) => `<option value="${d.day}">${d.day} (${d.count})</option>`).join("");
  } catch (e) {
    console.warn("days endpoint failed", e);
  }
}

async function refresh() {
  saveCreds();
  setStatus("loading...");
  const day = $("day").value;
  const type = $("type-filter").value;
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  if (type) params.set("type", type);
  params.set("limit", "300");
  let data;
  try {
    data = await api("/events?" + params.toString());
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  const filt = [];
  if (day) filt.push(day);
  if (type) filt.push(type);
  // server may or may not honor ?type=; filter client-side as a safety net
  const filtered = type ? data.events.filter((e) => e.type === type) : data.events;
  setStatus(`${filtered.length} events${filt.length ? " (" + filt.join(", ") + ")" : ""}.`);
  render(filtered);
  $("empty").hidden = true;
  $("content").hidden = false;
}

// ============================================================
// Rendering
// ============================================================

function render(events) {
  renderStats(events);
  renderFeed(events);
  renderAggregates(events);
  $("raw").textContent = events.slice(0, 50).map((e) => JSON.stringify(e)).join("\n");
}

function renderStats(events) {
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
}

// ============================================================
// Per-event feed
// ============================================================

function renderFeed(events) {
  const el = $("feed");
  el.innerHTML = "";
  if (events.length === 0) {
    el.innerHTML = '<div class="muted">no events.</div>';
    return;
  }
  for (const e of events) {
    el.appendChild(eventCard(e));
  }
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "event event-" + (e.type || "unknown");

  const time = (e.time || "").replace("T", " ").replace("Z", "");
  const tags = [];
  tags.push(`<span class="tag tag-type">${escapeHtml(e.type || "?")}</span>`);
  if (e.type === "level_end") {
    const o = e.data?.outcome;
    if (o) tags.push(`<span class="tag tag-${o}">${escapeHtml(o)}</span>`);
  }
  if (e.data?.level != null) tags.push(`<span class="tag">L${escapeHtml(String(e.data.level))}</span>`);
  if (e.data?.ng_plus) tags.push(`<span class="tag">NG+${escapeHtml(String(e.data.ng_plus))}</span>`);
  if (e.data?.difficulty) tags.push(`<span class="tag">${escapeHtml(e.data.difficulty)}</span>`);
  if (e.os) tags.push(`<span class="tag tag-muted">${escapeHtml(e.os)}</span>`);

  div.innerHTML = `
    <div class="event-head">
      <span class="time">${escapeHtml(time)}</span>
      ${tags.join(" ")}
    </div>
  `;

  const body = document.createElement("div");
  body.className = "event-body";
  if (e.type === "crash") {
    body.appendChild(renderCrashBody(e));
  } else if (e.type === "buy_screen_end" || e.type === "level_end") {
    body.appendChild(renderRunBody(e));
  } else {
    body.innerHTML = `<pre class="raw">${escapeHtml(JSON.stringify(e.data || {}, null, 2))}</pre>`;
  }
  div.appendChild(body);
  return div;
}

function renderCrashBody(e) {
  const wrap = document.createElement("div");
  wrap.className = "crash-body";
  const msg = e.data?.message || "";
  const tb = e.data?.traceback || "";
  wrap.innerHTML = `
    <div class="crash-msg">${escapeHtml(msg)}</div>
    ${tb ? `<pre class="trace">${escapeHtml(tb)}</pre>` : ""}
  `;
  return wrap;
}

function renderRunBody(e) {
  const wrap = document.createElement("div");
  wrap.className = "run-body";
  const d = e.data || {};

  // units + items (by name, no slot numbers)
  const unitsHtml = (d.units || []).map((u) => {
    const items = (u.items || []).filter((x) => x && x !== "");
    const itemsTxt = items.length ? items.join(", ") : "<span class=\"muted\">(no items)</span>";
    const lvl = u.level != null ? ` L${escapeHtml(String(u.level))}` : "";
    return `<li><span class="char">${escapeHtml(u.character || "?")}${lvl}</span> — <span class="items">${itemsTxt}</span></li>`;
  }).join("");

  // meta (colors / tiers / bonuses)
  let metaHtml = "";
  if (d.meta) {
    const colors = d.meta.colors || {};
    const tiers = d.meta.tiers || {};
    const bonuses = d.meta.bonuses || {};
    const colorChips = Object.entries(colors)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => {
        const t = Number(tiers[c] || 0);
        const tierTxt = t > 0 ? ` T${t}` : "";
        return `<span class="chip chip-${escapeHtml(c)}">${escapeHtml(c)} ${n}${tierTxt}</span>`;
      }).join(" ");
    const bonusTxt = Object.entries(bonuses)
      .map(([s, v]) => `${s} +${(Number(v) * 100).toFixed(0)}%`)
      .join(", ");
    if (colorChips || bonusTxt) {
      metaHtml = `
        <div class="row"><span class="row-lbl">meta</span><span class="row-val">${colorChips}</span></div>
        ${bonusTxt ? `<div class="row"><span class="row-lbl">bonuses</span><span class="row-val">${escapeHtml(bonusTxt)}</span></div>` : ""}
      `;
    }
  }

  // misc scalar fields
  const scalars = [];
  if (d.gold != null) scalars.push(`gold ${escapeHtml(String(d.gold))}`);
  if (d.times_rerolled != null) scalars.push(`rerolls ${escapeHtml(String(d.times_rerolled))}`);
  if (d.time_elapsed != null) scalars.push(`${Math.round(Number(d.time_elapsed))}s`);
  if (d.damage_dealt != null) scalars.push(`dmg dealt ${escapeHtml(String(Math.round(Number(d.damage_dealt))))}`);
  if (d.damage_taken != null) scalars.push(`dmg taken ${escapeHtml(String(Math.round(Number(d.damage_taken))))}`);
  if (Array.isArray(d.passives) && d.passives.length) scalars.push(`passives ${d.passives.length}`);
  if (Array.isArray(d.perks) && d.perks.length) scalars.push(`perks ${d.perks.length}`);

  wrap.innerHTML = `
    ${unitsHtml ? `<div class="row"><span class="row-lbl">units</span><ul class="units">${unitsHtml}</ul></div>` : ""}
    ${metaHtml}
    ${scalars.length ? `<div class="row"><span class="row-lbl">stats</span><span class="row-val">${scalars.join(" · ")}</span></div>` : ""}
  `;
  return wrap;
}

// ============================================================
// Secondary aggregates (collapsed by default)
// ============================================================

function renderAggregates(events) {
  // deaths by level
  const deathsByLevel = {};
  for (const e of events) {
    if (e.type === "level_end" && e.data?.outcome === "loss") {
      const lv = e.data.level ?? "?";
      deathsByLevel[lv] = (deathsByLevel[lv] || 0) + 1;
    }
  }
  renderBars("chart-deaths", deathsByLevel, { sortKey: "key-num" });

  // win/loss by level
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

  // item popularity
  const itemCount = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    for (const u of e.data?.units || []) {
      for (const it of u.items || []) {
        if (it && it !== "") itemCount[it] = (itemCount[it] || 0) + 1;
      }
    }
  }
  renderBars("chart-items", itemCount, { sortKey: "value-desc", limit: 25 });

  // character pick rate
  const charCount = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    for (const u of e.data?.units || []) {
      if (u.character) charCount[u.character] = (charCount[u.character] || 0) + 1;
    }
  }
  renderBars("chart-chars", charCount, { sortKey: "value-desc", limit: 25 });

  // meta color totals
  const colorTotals = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    const colors = e.data?.meta?.colors;
    if (!colors) continue;
    for (const k of Object.keys(colors)) colorTotals[k] = (colorTotals[k] || 0) + Number(colors[k] || 0);
  }
  renderBars("chart-colors", colorTotals, { sortKey: "value-desc" });

  // meta tiers reached
  const tierCounts = {};
  for (const e of events) {
    if (e.type !== "buy_screen_end") continue;
    const tiers = e.data?.meta?.tiers;
    if (!tiers) continue;
    for (const color of Object.keys(tiers)) {
      const t = Number(tiers[color] || 0);
      if (t > 0) {
        const key = color + " T" + t;
        tierCounts[key] = (tierCounts[key] || 0) + 1;
      }
    }
  }
  renderBars("chart-tiers", tierCounts, { sortKey: "value-desc" });
}

function renderBars(elId, counts, opts = {}) {
  const el = $(elId);
  if (!el) return;
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
  if (!el) return;
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
  $("type-filter").addEventListener("change", refresh);

  if (localStorage.getItem(LS_URL) && localStorage.getItem(LS_TOKEN)) {
    loadDays().then(refresh);
  }
});
