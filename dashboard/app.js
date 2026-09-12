// UNDERLOD telemetry dashboard.
// All client-side. Worker URL + token live in localStorage on this device.
// Never commit a token to the repo — they're paste-on-load only.
//
// Data sources:
//   GET  /summary       merged per-day rollups (summary/all.json) — history charts
//   POST /rollup?day=   fold new raw files into the rollups (backfill on load)
//   GET  /events        latest ~45 raw uploads — the "recent runs" feed

const LS_URL = "underlod.worker_url";
const LS_TOKEN = "underlod.token";
const LS_RANGE = "underlod.range";

// Default worker URL — not a secret (it's in the game binary). Saved
// localStorage value still takes precedence if the user changed it.
const DEFAULT_WORKER_URL = "https://underlod-logging.sdwr.workers.dev";

// How many rollup calls a single refresh may issue (each reads <= 38 files).
const MAX_ROLLUP_CALLS = 30;
// Runs shown in the feed before a "show more" button.
const FEED_PAGE = 40;

const SERIES = [
  { key: "runs", label: "runs", color: "var(--s-runs)" },
  { key: "installs", label: "players", color: "var(--s-players)" },
  { key: "crashes", label: "crashes", color: "var(--s-crashes)" },
];

const $ = (id) => document.getElementById(id);

// ---- state ----
let summaryData = null;   // { today, days, all }
let dates = {};           // event-date -> merged metrics
let rangeDays = Number(localStorage.getItem(LS_RANGE) || 30);
let feedEvents = [];      // last fetched raw events (for client-side re-sort)
let activityRows = [];    // rows behind the activity chart (for the table view)
let backfillPending = false; // true when a refresh hit the rollup budget
let feedLimit = FEED_PAGE;

// ============================================================
// Credentials / settings
// ============================================================

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
  // This page is served over https, so an http:// worker URL would be blocked
  // as mixed content and fetch() rejects with an opaque "Failed to fetch".
  // Upgrade it (except for localhost, used during local dev).
  if (url && location.protocol === "https:" && /^http:\/\//i.test(url) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
    url = url.replace(/^http:/i, "https:");
  }
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

function hasCreds() {
  return !!(localStorage.getItem(LS_URL) && localStorage.getItem(LS_TOKEN));
}

function toggleSettings(force) {
  const el = $("settings");
  const show = force != null ? force : el.hidden;
  el.hidden = !show;
  $("settings-toggle").setAttribute("aria-expanded", String(show));
}

async function api(path, opts = {}) {
  const base = localStorage.getItem(LS_URL);
  const token = localStorage.getItem(LS_TOKEN);
  if (!base || !token) throw new Error("missing worker URL or token");
  let res;
  try {
    res = await fetch(base + path, {
      method: opts.method || "GET",
      headers: { Authorization: "Bearer " + token },
    });
  } catch (e) {
    throw new Error(`could not reach worker at ${base} — check the URL, your network, or ad-blockers (${e.message})`);
  }
  if (res.status === 401) throw new Error("unauthorized — check the token");
  if (!res.ok) throw new Error(`worker returned ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ============================================================
// Refresh pipeline
// ============================================================

async function refresh() {
  if (!hasCreds()) { toggleSettings(true); return; }
  setStatus("loading summary…");
  document.body.classList.add("loading");
  try {
    summaryData = await api("/summary");
    await backfillRollups();
    rebuildDates();
    renderHistory();
    $("empty").hidden = true;
    $("content").hidden = false;
    await refreshFeed();
    const n = Object.keys(dates).length;
    setStatus(`${n} day${n === 1 ? "" : "s"} of history · updated ${new Date().toLocaleTimeString()}` +
      (backfillPending ? " · older days still rolling up — refresh again" : ""));
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    document.body.classList.remove("loading");
  }
}

// Fold any raw files the rollups haven't seen yet. Past days are done once
// `complete`; today is always re-rolled (it only reads files newer than the
// stored cursor, so this is cheap).
async function backfillRollups() {
  const { today, days, all } = summaryData;
  backfillPending = false;
  const todo = [];
  for (const d of days) {
    if (d === today) todo.push(d);
    else if (d < today && !(all.days[d] && all.days[d].complete)) todo.push(d);
  }
  // Newest first so the most relevant history fills in earliest.
  todo.sort().reverse();
  if (!todo.length) return;

  let calls = 0, dirty = false;
  for (const day of todo) {
    let remaining = true;
    while (remaining && calls < MAX_ROLLUP_CALLS) {
      setStatus(`rolling up ${day}… (${calls + 1}/${MAX_ROLLUP_CALLS})`);
      const r = await api("/rollup?day=" + day, { method: "POST" });
      calls++; dirty = true;
      remaining = r.remaining;
    }
    if (calls >= MAX_ROLLUP_CALLS) break;
  }
  if (dirty) summaryData = await api("/summary");
  backfillPending = calls >= MAX_ROLLUP_CALLS;
}

// Merge every receipt-day's per-date metrics into one date -> metrics map.
function rebuildDates() {
  dates = {};
  for (const day of Object.values(summaryData.all.days || {})) {
    for (const [date, m] of Object.entries(day.dates || {})) {
      const t = (dates[date] ||= emptyMetrics());
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "number") t[k] = (t[k] || 0) + v;
        else if (v && typeof v === "object") {
          const tc = (t[k] ||= {});
          for (const [kk, vv] of Object.entries(v)) tc[kk] = (tc[kk] || 0) + Number(vv || 0);
        }
      }
    }
  }
}

function emptyMetrics() {
  return {
    events: 0, runs: 0, installs: 0, crashes: 0, level_ends: 0,
    wins: 0, losses: 0, completes: 0, time_elapsed: 0, damage_dealt: 0, damage_taken: 0,
    level_starts: {}, deaths_by_level: {}, wins_by_level: {}, ends_by_level: {},
    duration_by_level: {}, damage_taken_by_level: {},
    chars: {}, items: {}, os: {}, versions: {}, crash_messages: {},
  };
}

// ---- date helpers ----
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateSpan(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso) {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

// The current period, and the equal-length period before it (for deltas).
function periods() {
  const today = summaryData.today;
  const known = Object.keys(dates).sort();
  let from;
  if (rangeDays > 0) from = addDays(today, -(rangeDays - 1));
  else from = known[0] || today;
  const cur = dateSpan(from, today);
  const prev = rangeDays > 0 ? dateSpan(addDays(from, -rangeDays), addDays(from, -1)) : [];
  return { cur, prev };
}

function sumMetrics(dayList) {
  const t = emptyMetrics();
  for (const d of dayList) {
    const m = dates[d];
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "number") t[k] += v;
      else for (const [kk, vv] of Object.entries(v)) t[k][kk] = (t[k][kk] || 0) + vv;
    }
  }
  return t;
}

// ============================================================
// History rendering
// ============================================================

function renderHistory() {
  const { cur, prev } = periods();
  const curTotals = sumMetrics(cur);
  const prevTotals = prev.length ? sumMetrics(prev) : null;
  renderTiles(cur, curTotals, prevTotals);
  renderActivity(cur);
  renderAggregates(curTotals);
  $("activity-sub").textContent = rangeDays > 0
    ? `last ${rangeDays} days · per day`
    : `${shortDate(cur[0])} – ${shortDate(cur[cur.length - 1])} · per day`;
}

function renderTiles(cur, t, p) {
  const defs = [
    { key: "runs", label: "runs", good: "up" },
    { key: "installs", label: "players", good: "up" },
    { key: "completes", label: "run completes", good: "up" },
    { key: "losses", label: "deaths", good: null },
    { key: "crashes", label: "crashes", good: "down" },
    { key: "avg_level_secs", label: "avg level time", good: null, unit: "s", derived: (m) => m.level_ends ? m.time_elapsed / m.level_ends : 0 },
    { key: "avg_dmg_taken", label: "dmg taken / level", good: "down", derived: (m) => m.level_ends ? m.damage_taken / m.level_ends : 0 },
  ];
  const el = $("tiles");
  el.innerHTML = "";
  for (const d of defs) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const get = (m) => (d.derived ? d.derived(m) : m[d.key] || 0);
    const val = get(t);
    const unit = d.unit || "";
    let deltaHtml = "";
    if (p) {
      const pv = get(p);
      const diff = val - pv;
      let cls = "";
      if (diff !== 0 && d.good) cls = (diff > 0) === (d.good === "up") ? "up" : "down";
      const pct = pv > 0 ? ` (${diff > 0 ? "+" : ""}${Math.round(100 * diff / pv)}%)` : "";
      const txt = fmt(Math.abs(diff)) === "0" ? "no change" : `${diff > 0 ? "+" : ""}${fmt(diff)}${unit}${pct}`;
      deltaHtml = `<span class="delta ${cls}" title="vs previous ${cur.length} days">${txt}</span>`;
    } else {
      deltaHtml = `<span class="delta">all time</span>`;
    }
    tile.innerHTML = `<span class="lbl">${escapeHtml(d.label)}</span><span class="val">${fmt(val)}${unit}</span>${deltaHtml}`;
    tile.appendChild(sparkline(cur.map((day) => (dates[day] ? get(dates[day]) : 0))));
    el.appendChild(tile);
  }
}

function sparkline(values) {
  const W = 72, H = 32;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i) => n === 1 ? W : (i / (n - 1)) * W;
  const y = (v) => H - 2 - (v / max) * (H - 4);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  if (n > 1) {
    const base = document.createElementNS("http://www.w3.org/2000/svg", "path");
    base.setAttribute("d", "M" + pts.join(" L"));
    svg.appendChild(base);
  }
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", x(n - 1)); dot.setAttribute("cy", y(values[n - 1] || 0)); dot.setAttribute("r", 2.5);
  svg.appendChild(dot);
  return svg;
}

// ---- activity line chart ----
function renderActivity(cur) {
  activityRows = cur.map((d) => {
    const m = dates[d] || {};
    const row = { date: d };
    for (const s of SERIES) row[s.key] = m[s.key] || 0;
    return row;
  });
  const legend = $("activity-legend");
  legend.innerHTML = SERIES.map((s) => `<span class="key"><i style="--c:${s.color}"></i>${escapeHtml(s.label)}</span>`).join("");
  drawLineChart($("activity-chart"), activityRows, SERIES);
  renderActivityTable();
}

function renderActivityTable() {
  const el = $("activity-table");
  const head = `<tr><th>date</th>${SERIES.map((s) => `<th>${escapeHtml(s.label)}</th>`).join("")}</tr>`;
  const body = [...activityRows].reverse().map((r) =>
    `<tr><td>${r.date}</td>${SERIES.map((s) => `<td>${r[s.key]}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawLineChart(container, rows, series) {
  container.innerHTML = "";
  container.classList.remove("hovering");
  $("tooltip").hidden = true;
  const W = Math.max(320, container.clientWidth || 800);
  const H = container.clientHeight || 260;
  const M = { l: 40, r: 56, t: 12, b: 26 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const n = rows.length;
  const maxV = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key]))));
  const x = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => M.t + ih - (v / maxV) * ih;

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

  // grid + y axis
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i;
    el("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }, grid);
    const t = el("text", { x: M.l - 8, y: y(v) + 4, "text-anchor": "end" }, axis);
    t.textContent = fmt(v);
  }
  // x labels: ~6 evenly spaced
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    const t = el("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : "middle" }, axis);
    t.textContent = shortDate(rows[i].date);
  }

  // series
  for (const s of series) {
    const g = el("g", { class: "series", style: `--c:${s.color}` }, svg);
    const pts = rows.map((r, i) => [x(i), y(r[s.key])]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    if (n > 1) {
      el("path", { class: "area", d: `${d} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` }, g);
      el("path", { class: "line", d }, g);
    }
    const last = pts[n - 1];
    el("circle", { cx: last[0], cy: last[1], r: 4 }, g);
    const lbl = el("text", { class: "end-label", x: last[0] + 8, y: last[1] + 4 }, g);
    lbl.textContent = fmt(rows[n - 1][s.key]);
  }
  // Nudge colliding end-labels apart (leader-free: they sit right of the plot).
  const labels = [...svg.querySelectorAll(".end-label")].sort((a, b) => Number(a.getAttribute("y")) - Number(b.getAttribute("y")));
  for (let i = 1; i < labels.length; i++) {
    const prev = Number(labels[i - 1].getAttribute("y")), cur = Number(labels[i].getAttribute("y"));
    if (cur - prev < 12) labels[i].setAttribute("y", prev + 12);
  }

  // hover layer
  const cross = el("line", { class: "crosshair", y1: M.t, y2: M.t + ih, x1: 0, x2: 0 }, svg);
  const dots = series.map((s) => el("circle", { class: "hover-dot", r: 4, style: `--c:${s.color}` }, svg));
  const hit = el("rect", { x: M.l, y: M.t, width: iw, height: ih, fill: "transparent" }, svg);
  const tip = $("tooltip");

  const showAt = (i, clientX, clientY) => {
    const r = rows[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    series.forEach((s, k) => { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(r[s.key])); });
    container.classList.add("hovering");
    tip.innerHTML = "";
    const title = document.createElement("div");
    title.className = "tt-title"; title.textContent = r.date;
    tip.appendChild(title);
    for (const s of series) {
      const row = document.createElement("div");
      row.className = "tt-row";
      const key = document.createElement("i"); key.style.setProperty("--c", s.color);
      const b = document.createElement("b"); b.textContent = String(r[s.key]);
      const span = document.createElement("span"); span.textContent = s.label;
      row.append(key, b, span);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = clientX + 14, top = clientY - th / 2;
    if (left + tw > window.innerWidth - 8) left = clientX - tw - 14;
    top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
    tip.style.left = left + "px"; tip.style.top = top + "px";
  };
  const hide = () => { container.classList.remove("hovering"); tip.hidden = true; };
  hit.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const i = n === 1 ? 0 : Math.round(((px - M.l) / iw) * (n - 1));
    showAt(Math.max(0, Math.min(n - 1, i)), ev.clientX, ev.clientY);
  });
  hit.addEventListener("pointerleave", hide);
  container.appendChild(svg);
}

// ---- aggregate bar charts ----
function renderAggregates(t) {
  // survival: share of runs that reached each level (buy_screen_end at level L)
  const starts = t.level_starts || {};
  const levels = Object.keys(starts).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const base = starts[levels[0]] || 0;
  renderBars("chart-survival", levels.map((lv) => ({
    label: "L" + lv,
    segs: [{ v: starts[lv], c: "var(--s-runs)", title: `${starts[lv]} runs reached L${lv}` }],
    text: base ? `${Math.round(100 * starts[lv] / base)}%` : String(starts[lv]),
  })), { max: base || 1 });

  // outcomes by level: wins (incl. completes) vs deaths, stacked
  const wl = {};
  for (const [lv, n] of Object.entries(t.wins_by_level || {})) (wl[lv] ||= { w: 0, l: 0 }).w += n;
  for (const [lv, n] of Object.entries(t.deaths_by_level || {})) (wl[lv] ||= { w: 0, l: 0 }).l += n;
  const lvKeys = Object.keys(wl).sort((a, b) => Number(a) - Number(b));
  $("outcome-legend").innerHTML =
    `<span class="key"><i class="box" style="--c:var(--good)"></i>won</span><span class="key"><i class="box" style="--c:var(--critical)"></i>died</span>`;
  renderBars("chart-outcomes", lvKeys.map((lv) => ({
    label: "L" + lv,
    segs: [
      { v: wl[lv].w, c: "var(--good)", title: `${wl[lv].w} won` },
      { v: wl[lv].l, c: "var(--critical)", title: `${wl[lv].l} died` },
    ],
    text: `${wl[lv].w}/${wl[lv].w + wl[lv].l}`,
  })));

  // per-level averages: sum / number of level_end events at that level
  const ends = t.ends_by_level || {};
  const avgByLevel = (sums) => Object.keys(ends).filter((lv) => ends[lv] > 0)
    .sort((a, b) => Number(a) - Number(b))
    .map((lv) => ({ lv, avg: (sums[lv] || 0) / ends[lv], n: ends[lv] }));
  renderBars("chart-duration", avgByLevel(t.duration_by_level).map(({ lv, avg, n }) => ({
    label: "L" + lv, segs: [{ v: avg, c: "var(--s-runs)", title: `${n} level end${n === 1 ? "" : "s"}` }], text: fmtSecs(avg),
  })));
  renderBars("chart-dmg-taken", avgByLevel(t.damage_taken_by_level).map(({ lv, avg, n }) => ({
    label: "L" + lv, segs: [{ v: avg, c: "var(--s-crashes)", title: `${n} level end${n === 1 ? "" : "s"}` }], text: fmt(avg),
  })));

  renderBars("chart-chars", topEntries(t.chars, 25).map(([k, v]) => ({ label: k, segs: [{ v, c: "var(--s-players)" }], text: String(v) })));
  renderBars("chart-items", topEntries(t.items, 20).map(([k, v]) => ({ label: k, segs: [{ v, c: "var(--accent)" }], text: String(v) })));
  renderBars("chart-crashes", topEntries(t.crash_messages, 15).map(([k, v]) => ({ label: k, mono: true, segs: [{ v, c: "var(--s-crashes)" }], text: String(v) })), { wide: true });

  const plat = [
    ...topEntries(t.os, 10).map(([k, v]) => ({ label: k, segs: [{ v, c: "var(--s-runs)" }], text: String(v) })),
    ...topEntries(t.versions, 10).map(([k, v]) => ({ label: "v" + k, segs: [{ v, c: "var(--s-players)" }], text: String(v) })),
  ];
  renderBars("chart-platform", plat);
}

function fmtSecs(s) {
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.round(s)}s`;
}

function topEntries(obj, limit) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// rows: [{label, segs:[{v, c, title}], text, mono}]
function renderBars(elId, rows, opts = {}) {
  const el = $(elId);
  el.innerHTML = "";
  if (!rows.length) { el.innerHTML = '<div class="nodata">no data in this range.</div>'; return; }
  const max = opts.max || Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.v, 0)));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "bar-row" + (opts.wide ? " wide" : "");
    const lbl = document.createElement("span");
    lbl.className = "lbl" + (r.mono ? " mono" : ""); lbl.textContent = r.label; lbl.title = r.label;
    const track = document.createElement("span");
    track.className = "track";
    for (const s of r.segs) {
      if (!s.v) continue;
      const seg = document.createElement("span");
      seg.style.width = (100 * s.v / max).toFixed(2) + "%";
      seg.style.setProperty("--c", s.c);
      seg.title = s.title || `${r.label}: ${s.v}`;
      track.appendChild(seg);
    }
    const val = document.createElement("span");
    val.className = "val"; val.textContent = r.text;
    row.append(lbl, track, val);
    el.appendChild(row);
  }
}

// ============================================================
// Recent runs feed (raw events)
// ============================================================

async function refreshFeed() {
  const day = $("day").value;
  const type = $("type-filter").value;
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  params.set("limit", "45");
  const data = await api("/events?" + params.toString());
  feedEvents = type ? data.events.filter((e) => e.type === type) : data.events;
  feedLimit = FEED_PAGE;
  $("runs-sub").textContent = `${feedEvents.length} events from the latest ${data.file_count} uploads${day ? " on " + day : ""}`;
  renderFeed(feedEvents);
  $("raw").textContent = feedEvents.slice(0, 50).map((e) => JSON.stringify(e)).join("\n");
}

function populateDays() {
  const sel = $("day");
  const keep = sel.value;
  sel.innerHTML = '<option value="">latest</option>' +
    (summaryData.days || []).map((d) => `<option value="${d}">${d}</option>`).join("");
  sel.value = keep;
}

function renderFeed(events) {
  const el = $("feed");
  el.innerHTML = "";
  if (!events.length) { el.innerHTML = '<div class="nodata">no events.</div>'; return; }

  const groups = new Map();
  for (const e of events) {
    const key = e.run || "(no run)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const runs = [];
  for (const [run, evs] of groups) {
    evs.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    let lastTime = "";
    for (const e of evs) if ((e.time || "") > lastTime) lastTime = e.time;
    let player = "";
    for (const e of evs) { if (e.player) { player = e.player; break; } }
    if (!player) for (const e of evs) { if (e.install) { player = e.install; break; } }
    runs.push({ run, evs, lastTime, player: player || "?", outcome: runOutcome(evs) });
  }
  const mode = $("sort").value || "recent";
  if (mode === "player") {
    const lastByPlayer = new Map();
    for (const r of runs) {
      const cur = lastByPlayer.get(r.player) || "";
      if (r.lastTime > cur) lastByPlayer.set(r.player, r.lastTime);
    }
    runs.sort((a, b) => {
      const pa = lastByPlayer.get(a.player) || "", pb = lastByPlayer.get(b.player) || "";
      if (pa !== pb) return pb.localeCompare(pa);
      if (a.player !== b.player) return a.player.localeCompare(b.player);
      return b.lastTime.localeCompare(a.lastTime);
    });
  } else {
    runs.sort((a, b) => b.lastTime.localeCompare(a.lastTime));
  }
  for (const r of runs.slice(0, feedLimit)) el.appendChild(runGroup(r));
  if (runs.length > feedLimit) {
    const more = document.createElement("button");
    more.className = "btn ghost small";
    more.textContent = `show ${Math.min(FEED_PAGE, runs.length - feedLimit)} more of ${runs.length} runs`;
    more.addEventListener("click", () => { feedLimit += FEED_PAGE; renderFeed(events); });
    el.appendChild(more);
  }
}

// evs newest-first. Classify a run from its most recent meaningful event.
function runOutcome(evs) {
  if (evs.some((e) => e.type === "crash")) return { text: "crashed", c: "var(--critical)" };
  const last = evs[0];
  const d = last?.data || {};
  if (last?.type === "level_end") {
    if (d.outcome === "run_complete") return { text: "completed", c: "var(--good)" };
    if (d.outcome === "loss") return { text: `died L${d.level ?? "?"}`, c: "var(--critical)" };
    if (d.outcome === "win") return { text: `won L${d.level ?? "?"}`, c: "var(--s-runs)" };
  }
  if (last?.type === "buy_screen_end") return { text: `shop L${d.level ?? "?"}`, c: "var(--accent)" };
  return { text: last?.type || "?", c: "var(--muted)" };
}

function shortId(s) { return s.length > 12 ? s.slice(0, 8) : s; }

function runCharacters(evs) {
  for (const e of evs) {
    const units = e.data?.units;
    if (Array.isArray(units) && units.length) {
      const names = units.map((u) => u.character).filter(Boolean);
      if (names.length) return names.join(", ");
    }
  }
  return "";
}

function runGroup(r) {
  const det = document.createElement("details");
  det.className = "run";
  const chars = runCharacters(r.evs);
  const counts = {};
  for (const e of r.evs) counts[e.type || "?"] = (counts[e.type || "?"] || 0) + 1;
  const countTxt = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(" · ");
  const last = (r.lastTime || "").replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  const sum = document.createElement("summary");
  sum.innerHTML = `
    <span class="run-outcome" style="--c:${r.outcome.c}">${escapeHtml(r.outcome.text)}</span>
    <span class="run-main">
      ${chars ? `<span class="run-chars">${escapeHtml(chars)}</span>` : ""}
      <span class="run-meta">${escapeHtml(countTxt)}</span>
      ${r.player !== "?" ? `<span class="run-id" title="player ${escapeHtml(r.player)}">${escapeHtml(shortId(r.player))}</span>` : ""}
      <span class="run-id" title="run ${escapeHtml(r.run)}">${escapeHtml(shortId(r.run))}</span>
    </span>
    <span class="run-time">${escapeHtml(last)}</span>`;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "run-events";
  det.addEventListener("toggle", () => {
    if (det.open && !body.childElementCount) for (const e of r.evs) body.appendChild(eventCard(e));
  }, { once: true });
  det.appendChild(body);
  return det;
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "event event-" + (e.type || "unknown");
  const time = (e.time || "").replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  const tags = [`<span class="tag tag-type">${escapeHtml(e.type || "?")}</span>`];
  if (e.type === "level_end" && e.data?.outcome) tags.push(`<span class="tag tag-${escapeHtml(e.data.outcome)}">${escapeHtml(e.data.outcome)}</span>`);
  if (e.data?.level != null) tags.push(`<span class="tag">L${escapeHtml(String(e.data.level))}</span>`);
  if (e.data?.ng_plus) tags.push(`<span class="tag">NG+${escapeHtml(String(e.data.ng_plus))}</span>`);
  if (e.data?.difficulty) tags.push(`<span class="tag">${escapeHtml(e.data.difficulty)}</span>`);
  if (e.os) tags.push(`<span class="tag">${escapeHtml(e.os)}</span>`);
  if (e.version) tags.push(`<span class="tag">v${escapeHtml(e.version)}</span>`);
  div.innerHTML = `<div class="event-head"><span class="time">${escapeHtml(time)}</span>${tags.join(" ")}</div>`;
  const body = document.createElement("div");
  if (e.type === "crash") body.appendChild(renderCrashBody(e));
  else if (e.type === "buy_screen_end" || e.type === "level_end") body.appendChild(renderRunBody(e));
  else body.innerHTML = `<pre class="raw">${escapeHtml(JSON.stringify(e.data || {}, null, 2))}</pre>`;
  div.appendChild(body);
  return div;
}

function renderCrashBody(e) {
  const wrap = document.createElement("div");
  const msg = e.data?.message || "";
  const tb = e.data?.traceback || "";
  wrap.innerHTML = `<div class="crash-msg">${escapeHtml(msg)}</div>${tb ? `<pre class="trace">${escapeHtml(tb)}</pre>` : ""}`;
  return wrap;
}

function renderRunBody(e) {
  const wrap = document.createElement("div");
  const d = e.data || {};
  const unitsHtml = (d.units || []).map((u) => {
    const items = (u.items || []).filter((x) => x && x !== "");
    const itemsTxt = items.length ? escapeHtml(items.join(", ")) : '<span class="muted">(no items)</span>';
    const lvl = u.level != null ? ` L${escapeHtml(String(u.level))}` : "";
    return `<li><span class="char">${escapeHtml(u.character || "?")}${lvl}</span> — <span class="items">${itemsTxt}</span></li>`;
  }).join("");

  let metaHtml = "";
  if (d.meta) {
    const colors = d.meta.colors || {}, tiers = d.meta.tiers || {}, bonuses = d.meta.bonuses || {};
    const colorChips = Object.entries(colors).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
      .map(([c, n]) => {
        const t = Number(tiers[c] || 0);
        return `<span class="chip chip-${escapeHtml(c)}">${escapeHtml(c)} ${n}${t > 0 ? ` T${t}` : ""}</span>`;
      }).join(" ");
    const bonusTxt = Object.entries(bonuses).map(([s, v]) => `${s} +${(Number(v) * 100).toFixed(0)}%`).join(", ");
    if (colorChips || bonusTxt) {
      metaHtml = `<div class="row"><span class="row-lbl">meta</span><span>${colorChips}</span></div>` +
        (bonusTxt ? `<div class="row"><span class="row-lbl">bonuses</span><span>${escapeHtml(bonusTxt)}</span></div>` : "");
    }
  }

  const scalars = [];
  if (d.gold != null) scalars.push(`gold ${d.gold}`);
  if (d.times_rerolled != null) scalars.push(`rerolls ${d.times_rerolled}`);
  if (d.time_elapsed != null) scalars.push(`${Math.round(Number(d.time_elapsed))}s`);
  if (d.damage_dealt != null) scalars.push(`dmg dealt ${Math.round(Number(d.damage_dealt))}`);
  if (d.damage_taken != null) scalars.push(`dmg taken ${Math.round(Number(d.damage_taken))}`);
  if (Array.isArray(d.passives) && d.passives.length) scalars.push(`passives ${d.passives.length}`);
  if (Array.isArray(d.perks) && d.perks.length) scalars.push(`perks ${d.perks.length}`);

  wrap.innerHTML =
    (unitsHtml ? `<div class="row"><span class="row-lbl">units</span><ul class="units">${unitsHtml}</ul></div>` : "") +
    metaHtml +
    (scalars.length ? `<div class="row"><span class="row-lbl">stats</span><span>${escapeHtml(scalars.join(" · "))}</span></div>` : "");
  return wrap;
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
  for (const b of document.querySelectorAll(".range button")) {
    b.classList.toggle("active", Number(b.dataset.range) === rangeDays);
    b.addEventListener("click", () => {
      rangeDays = Number(b.dataset.range);
      localStorage.setItem(LS_RANGE, String(rangeDays));
      for (const o of document.querySelectorAll(".range button")) o.classList.toggle("active", o === b);
      if (summaryData) renderHistory();
    });
  }
  $("refresh").addEventListener("click", () => { populateDaysSafe(); refresh(); });
  $("save").addEventListener("click", () => { saveCreds(); toggleSettings(false); refresh(); });
  $("logout").addEventListener("click", clearCreds);
  $("settings-toggle").addEventListener("click", () => toggleSettings());
  $("token").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("save").click(); });

  $("day").addEventListener("change", () => refreshFeed().catch((e) => setStatus(e.message, true)));
  $("type-filter").addEventListener("change", () => refreshFeed().catch((e) => setStatus(e.message, true)));
  $("sort").addEventListener("change", () => renderFeed(feedEvents));
  $("activity-table-toggle").addEventListener("click", (ev) => {
    const on = $("activity-table").hidden;
    $("activity-table").hidden = !on;
    $("activity-chart").hidden = on;
    ev.currentTarget.setAttribute("aria-pressed", String(on));
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (summaryData && !$("activity-chart").hidden) drawLineChart($("activity-chart"), activityRows, SERIES); }, 120);
  });

  if (hasCreds()) refresh().then(populateDaysSafe);
  else toggleSettings(true);
});

function populateDaysSafe() { if (summaryData) populateDays(); }
