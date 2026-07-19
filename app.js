/* ═══════════════════════════════════════════════════════════════════════════
   R&F data explorer — app.js
   ───────────────────────────────────────────────────────────────────────────
   Plain ES module, no build step. Perspective (FINOS) is loaded from the
   jsDelivr CDN (semver tag "@3" → latest 3.x release).

   ── LLM INTEGRATION MAP ─────────────────────────────────────────────────────
   Three clearly-marked integration points are where this app is meant to
   talk to YOUR LLM engine (to be refined with context + RAG workflow):

     #1  queryLLM(prompt, context) ......... sends the chat prompt + app
                                             context to the LLM; returns
                                             { answer, dashboard? }
     #2  extractDashboardConfig(resp) ...... turns the LLM output into a
                                             Perspective view configuration
     #3  updateDashboardFromContext(cfg) ... applies it to the connected
                                             chart + table

   Search this file for "LLM INTEGRATION POINT" to jump to each of them.
   ═══════════════════════════════════════════════════════════════════════════ */

import perspective from "https://cdn.jsdelivr.net/npm/@perspective-dev/client/dist/cdn/perspective.js";
import "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer/dist/cdn/perspective-viewer.js";
import "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js";
import "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-charts/dist/cdn/perspective-viewer-charts.js";

// Tells the inline watchdog in index.html that the CDN modules loaded fine.
window.__rfAppStarted = true;

/* ── constants & state ─────────────────────────────────────────────────────── */

const GREETING = "hello Clement, what do you want to explore today?";
const DATA_URL = "mock_data.csv";

/** Default chart: total revenue over time. */
const DEFAULT_CHART_CONFIG = {
  plugin: "Y Line",
  group_by: ["date"],
  columns: ["revenue"],
  aggregates: { revenue: "sum" },
};

const state = {
  worker: null,          // Perspective worker
  table: null,           // ONE table shared by the table + chart viewers
  summary: null,         // pre-computed dataset stats → fed to the LLM as context
  llmEndpoint: localStorage.getItem("rf.llmEndpoint") ?? "",
  currentChartConfig: { ...DEFAULT_CHART_CONFIG },
};

const money = new Intl.NumberFormat("en-GB", {
  style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1,
});
const integer = new Intl.NumberFormat("en-GB");
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── bootstrap ─────────────────────────────────────────────────────────────── */

await init();

async function init() {
  initDateWidget();
  initPopovers();
  initResizer();
  initChat();

  // Default assistant message (with quick suggestions underneath).
  // addBotMessage(GREETING, {
  //  suggestions: ["Revenue by region", "Trend over time", "Compare desks", "Volume trend"],
  // });

  try {
    await initDashboard();
  } catch (err) {
    console.error(err);
    const chip = $("context-chip");
    chip.textContent = `⚠ ${err.message}`;
    chip.classList.add("context-chip--error");
  }
}

/* ── dashboard (Perspective) ───────────────────────────────────────────────── */

async function initDashboard() {
  // state.worker = perspective.worker();
  const worker = await perspective.worker();


  // Mock data — later this fetch can be driven by the chat context instead.
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Could not load ${DATA_URL} (HTTP ${response.status})`);
  const data = await response.text();
  // state.table = await state.worker.table(data);   // Perspective parses CSV natively
  const table = await worker.table(data);   // Perspective parses CSV natively

  // const tableViewer = $("table-viewer");
  // const chartViewer = $("chart-viewer");
  await window.table_viewer.load(table);
  await window.chart_viewer.load(table);

  // Both viewers share the SAME table → any data/view update propagates to
  // both automatically. This is what makes the chart "connected".
  // await Promise.all([tableViewer.load(state.table), chartViewer.load(state.table)]);
  await chart_viewer.restore({ ...DEFAULT_CHART_CONFIG, theme: "Pro Light" });
  await table_viewer.restore({ plugin: "Datagrid", theme: "Pro Light" });

  // state.summary = await computeSummary();
  updateContextChip(DEFAULT_CHART_CONFIG);
}

/** Small stats bundle injected into the LLM context (see buildChatContext). */
async function computeSummary() {
  const totals = await state.table.view({
    columns: ["revenue", "volume"],
    aggregates: { revenue: "sum", volume: "sum" },
  });
  const cols = await totals.to_columns();
  await totals.delete();

  return {
    rowCount: await state.table.size(),
    totalRevenue: cols.revenue?.[0] ?? 0,
    totalVolume: cols.volume?.[0] ?? 0,
    byRegion: await aggregateBy("region"),
    byDesk: await aggregateBy("desk"),
  };
}

async function aggregateBy(column) {
  const view = await state.table.view({
    group_by: [column],
    columns: ["revenue"],
    aggregates: { revenue: "sum" },
  });
  const rows = await view.to_json();
  await view.delete();
  const out = {};
  for (const row of rows) {
    if (row.__ROW_PATH__?.length === 1) out[row.__ROW_PATH__[0]] = row.revenue;
  }
  return out;
}

/* ── chat UI ─────────────────────────────────────────────────────────────────
   Plain DOM rendering. The two functions that matter for the LLM wiring are
   handleUserPrompt() → queryLLM() (integration point #1, further below).    */

function initChat() {
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = "";
    void handleUserPrompt(prompt);
  });

  $("chat-history").addEventListener("scroll", updateScrollButton);
  $("scroll-bottom-button").addEventListener("click", () => scrollChatToBottom("smooth"));
}

/** Core chat flow: user prompt → LLM answer → dashboard update. */
async function handleUserPrompt(prompt) {
  addUserMessage(prompt);
  const typing = showTyping();
  try {
    /* ──▶ LLM INTEGRATION POINT #1 — the answer comes from queryLLM().     */
    const llmResponse = await queryLLM(prompt, buildChatContext());
    typing.remove();
    addBotMessage(llmResponse.answer);

    /* ──▶ LLM INTEGRATION POINTS #2 + #3 — answer → view config → apply.   */
    const dashboardConfig = extractDashboardConfig(llmResponse, prompt);
    if (dashboardConfig) await updateDashboardFromContext(dashboardConfig);
  } catch (err) {
    console.error(err);
    typing.remove();
    addBotMessage("⚠ Something went wrong while answering — please try again.");
  }
}

/**
 * Everything the LLM / RAG pipeline needs to ground its answer:
 * dataset schema, current chart configuration, summary stats, recent chat.
 */
function buildChatContext() {
  return {
    schema: { date: "date", region: "string", desk: "string", revenue: "float", volume: "integer" },
    currentView: state.currentChartConfig,
    summary: state.summary,
    history: getRecentMessages(10),
  };
}

function getRecentMessages(n) {
  return [...document.querySelectorAll("#chat-history .message:not(.typing)")]
    .slice(-n)
    .map((el) => ({
      role: el.classList.contains("message--user") ? "user" : "assistant",
      text: el.querySelector(".bubble")?.textContent ?? "",
    }));
}

function addMessage(role, text, { suggestions = [] } = {}) {
  const msg = document.createElement("div");
  msg.className = `message message--${role}`;

  if (role === "bot") {
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = "✦";
    msg.appendChild(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  body.append(bubble, time);

  if (suggestions.length) {
    const chips = document.createElement("div");
    chips.className = "suggestion-chips";
    for (const label of suggestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = label;
      chip.addEventListener("click", () => {
        $("chat-input").value = label;
        $("chat-form").requestSubmit();
      });
      chips.appendChild(chip);
    }
    body.appendChild(chips);
  }

  msg.appendChild(body);
  $("chat-history").appendChild(msg);
  scrollChatToBottom("smooth");
}

const addBotMessage = (text, opts) => addMessage("bot", text, opts);
const addUserMessage = (text) => addMessage("user", text);

function showTyping() {
  const el = document.createElement("div");
  el.className = "message message--bot typing";
  el.innerHTML = `<span class="message-avatar">✦</span>
    <div class="message-body"><div class="bubble bubble--typing" aria-label="Assistant is thinking">
    <span></span><span></span><span></span></div></div>`;
  $("chat-history").appendChild(el);
  scrollChatToBottom("smooth");
  return el;
}

/* ── chat : history scrolling ────────────────────────────────────────────── */

function isChatNearBottom() {
  const h = $("chat-history");
  return h.scrollHeight - h.scrollTop - h.clientHeight < 120;
}
function scrollChatToBottom(behavior = "auto") {
  const h = $("chat-history");
  h.scrollTo({ top: h.scrollHeight, behavior });
  updateScrollButton();
}
function updateScrollButton() {
  $("scroll-bottom-button").classList.toggle("is-visible", !isChatNearBottom());
}

/* ═══════════════════════════════════════════════════════════════════════════
   LLM INTEGRATION POINT #1 of 3 — queryLLM()
   ───────────────────────────────────────────────────────────────────────────
   ▶ THIS IS WHERE THE APP SHOULD CALL YOUR LLM ENGINE (context + RAG).

   Replace the mock below with your real endpoint. Suggested contract:

     POST <state.llmEndpoint>            (set it via the ⚙ Settings popover)
     { "prompt":  string,                  // raw user prompt from the chat
       "context": buildChatContext() }     // schema + current view + summary
                                           // + recent conversation history
     → response:
     { "answer":    string,                // text displayed in the chat
       "dashboard": {                      // OPTIONAL — drives points #2 + #3
         "plugin":     "Y Bar",            // any perspective-viewer plugin name
         "group_by":   ["region"],         // Perspective group_by (row pivots)
         "columns":    ["revenue"],        // numeric columns to aggregate
         "aggregates": { "revenue": "sum" }
       } }
   ═══════════════════════════════════════════════════════════════════════════ */
async function queryLLM(prompt, context) {
  if (state.llmEndpoint) {
    try {
      const res = await fetch(state.llmEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, context }),
      });
      if (!res.ok) throw new Error(`LLM endpoint answered HTTP ${res.status}`);
      return await res.json();              // ← real LLM path (contract above)
    } catch (err) {
      console.warn("LLM endpoint unreachable — falling back to mock.", err);
    }
  }

  // ── MOCK — delete once your endpoint is wired above ─────────────────────
  await sleep(500 + Math.random() * 600);   // simulate network latency
  return mockLLMResponse(prompt, context);
}

/* ═══════════════════════════════════════════════════════════════════════════
   LLM INTEGRATION POINT #2 of 3 — extractDashboardConfig()
   ───────────────────────────────────────────────────────────────────────────
   Translates the LLM response into a Perspective view configuration.
   With a real LLM, prefer STRUCTURED OUTPUT: have the model return the
   "dashboard" object directly (see contract in point #1) — this function
   then only validates it. Returns null when the dashboard should stay as-is.
   ═══════════════════════════════════════════════════════════════════════════ */
function extractDashboardConfig(llmResponse, _prompt) {
  if (!llmResponse?.dashboard) return null;

  const VALID_PLUGINS = new Set([
    "Datagrid", "Y Line", "Y Area", "Y Bar", "Y Scatter",
    "X/Y Scatter", "Treemap", "Sunburst", "Heatmap",
  ]);
  const VALID_COLUMNS = new Set(["date", "region", "desk", "revenue", "volume"]);

  const cfg = llmResponse.dashboard;
  const out = {};
  if (VALID_PLUGINS.has(cfg.plugin)) out.plugin = cfg.plugin;
  if (Array.isArray(cfg.group_by)) out.group_by = cfg.group_by.filter((c) => VALID_COLUMNS.has(c));
  if (Array.isArray(cfg.columns)) out.columns = cfg.columns.filter((c) => VALID_COLUMNS.has(c));
  if (cfg.aggregates && typeof cfg.aggregates === "object") out.aggregates = cfg.aggregates;
  return Object.keys(out).length ? out : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   LLM INTEGRATION POINT #3 of 3 — updateDashboardFromContext()
   ───────────────────────────────────────────────────────────────────────────
   Applies the LLM-chosen configuration to the dashboard. Because the chart
   and the table share ONE Perspective table, restoring the chart view keeps
   both in sync.

   ▶ If your RAG pipeline returns NEW DATA (filtered rows, another dataset),
     replace the rows here instead — both viewers will refresh automatically:
         await state.table.replace(newCsvOrJson);
   ═══════════════════════════════════════════════════════════════════════════ */
async function updateDashboardFromContext(config) {
  state.currentChartConfig = { ...state.currentChartConfig, ...config };
  await $("chart-viewer").restore(state.currentChartConfig);
  updateContextChip(state.currentChartConfig);
}

function updateContextChip(config) {
  const group = config.group_by?.length ? config.group_by.join(" → ") : "raw rows";
  const metric =
    config.columns?.filter((c) => !config.group_by?.includes(c)).join(", ") || "all columns";
  $("context-chip").textContent = `Chart: ${metric} by ${group}`;
}

/* ── mock LLM (placeholder until point #1 is wired to a real endpoint) ───────
   Keyword-based canned answers, grounded in the REAL summary stats computed
   from the dataset, so the demo already feels alive. Delete this when your
   RAG workflow is plugged in.                                              */
function mockLLMResponse(prompt, context) {
  const p = prompt.toLowerCase();
  const s = context.summary;
  const top = (obj) => Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1])[0] ?? ["—", 0];

  if (p.includes("region")) {
    const [best, val] = top(s?.byRegion);
    return {
      answer: `Here is revenue by region: ${best} leads with ${money.format(val)} out of ${money.format(s?.totalRevenue ?? 0)} total. Ask me to compare desks, or switch to volume.`,
      dashboard: { plugin: "Y Bar", group_by: ["region"], columns: ["revenue"], aggregates: { revenue: "sum" } },
    };
  }
  if (p.includes("desk") || p.includes("compare")) {
    const [best, val] = top(s?.byDesk);
    return {
      answer: `Comparing desks: ${best} is the top performer at ${money.format(val)}. The chart now shows revenue per desk — try "trend over time" for another angle.`,
      dashboard: { plugin: "Y Bar", group_by: ["desk"], columns: ["revenue"], aggregates: { revenue: "sum" } },
    };
  }
  if (p.includes("volume")) {
    return {
      answer: `Switching the chart to traded volume — ${integer.format(s?.totalVolume ?? 0)} contracts in total.`,
      dashboard: { plugin: "Y Line", group_by: ["date"], columns: ["volume"], aggregates: { volume: "sum" } },
    };
  }
  if (p.includes("area")) {
    return {
      answer: "Same revenue trend, rendered as an area chart.",
      dashboard: { plugin: "Y Area", group_by: ["date"], columns: ["revenue"], aggregates: { revenue: "sum" } },
    };
  }
  if (p.includes("treemap")) {
    return {
      answer: "Revenue contribution as a treemap, grouped by region.",
      dashboard: { plugin: "Treemap", group_by: ["region"], columns: ["revenue"], aggregates: { revenue: "sum" } },
    };
  }
  if (/trend|time|line|month|week|date/.test(p)) {
    return {
      answer: `Revenue trend across 2025 — ${money.format(s?.totalRevenue ?? 0)} over ${integer.format(s?.rowCount ?? 0)} records.`,
      dashboard: { ...DEFAULT_CHART_CONFIG },
    };
  }
  return {
    answer: `I'm exploring ${integer.format(s?.rowCount ?? 0)} records totalling ${money.format(s?.totalRevenue ?? 0)} in revenue. Try: "revenue by region", "compare desks", "trend over time" or "volume trend".`,
    dashboard: null,   // no dashboard change for this one
  };
}

/* ── header : date widget ──────────────────────────────────────────────────── */

function initDateWidget() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  $("date-widget-label").textContent = fmt.format(new Date());
}

/* ── header : popovers (settings / profile) ────────────────────────────────── */

function initPopovers() {
  setupPopover("settings-button", "settings-popover");
  setupPopover("profile-button", "profile-popover");

  // The endpoint URL is persisted in localStorage and read by queryLLM() —
  // this is the switch between the mock and your real LLM (point #1 above).
  const input = $("llm-endpoint-input");
  input.value = state.llmEndpoint;
  $("llm-endpoint-save").addEventListener("click", () => {
    state.llmEndpoint = input.value.trim();
    localStorage.setItem("rf.llmEndpoint", state.llmEndpoint);
    closeAllPopovers();
    addBotMessage(state.llmEndpoint
      ? `Got it — prompts will now be sent to ${state.llmEndpoint} (falling back to the mock if unreachable).`
      : "LLM endpoint cleared — using the built-in mock.");
  });

  document.addEventListener("click", closeAllPopovers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllPopovers();
  });
}

function setupPopover(buttonId, popoverId) {
  const button = $(buttonId);
  const popover = $(popoverId);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = popover.hidden;
    closeAllPopovers();
    popover.hidden = !willOpen;
  });
  popover.addEventListener("click", (e) => e.stopPropagation());
}

function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach((p) => { p.hidden = true; });
}

/* ── panel resizer (drag divider between chat and dashboard) ───────────────── */

function initResizer() {
  const resizer = $("panel-resizer");
  const chat = $("chat-panel");
  const main = $("app-main");
  let dragging = false;

  const applySplit = (pct) => {
    const clamped = Math.min(60, Math.max(25, pct));   // keep both panels usable
    chat.style.flexBasis = `${clamped}%`;
    resizer.setAttribute("aria-valuenow", String(Math.round(clamped)));
  };

  resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    applySplit(((e.clientX - rect.left) / rect.width) * 100);
  });
  resizer.addEventListener("pointerup", () => {
    dragging = false;
    document.body.classList.remove("is-resizing");
  });
  resizer.addEventListener("dblclick", () => applySplit(40));   // reset to 2/5

  // Keyboard accessibility: ← / → move the divider by 2 %
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const rect = main.getBoundingClientRect();
    const current = (chat.getBoundingClientRect().width / rect.width) * 100;
    applySplit(current + (e.key === "ArrowRight" ? 2 : -2));
  });
}
