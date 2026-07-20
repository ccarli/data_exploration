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
     #3  updateDashboardFromContext(cfg) ... applies it to the data table

   Search this file for "LLM INTEGRATION POINT" to jump to each of them.
   ═══════════════════════════════════════════════════════════════════════════ */

import perspective from "https://cdn.jsdelivr.net/npm/@perspective-dev/client/dist/cdn/perspective.js";
import "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer/dist/cdn/perspective-viewer.js";
import "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js";

// Tells the inline watchdog in index.html that the CDN modules loaded fine.
window.__rfAppStarted = true;

/* ── constants & state ─────────────────────────────────────────────────────── */

const GREETING = "hello Clement, what do you want to explore today?";
const DATA_URL = "mock_data.csv";

const state = {
  worker: null,          // Perspective worker
  table: null,           // Perspective table backing the data-table viewer
  summary: null,         // pre-computed dataset stats → fed to the LLM as context
  currentViewConfig:   // live view config of the table viewer
    {
      "version": "4.5.2",
      "columns_config": {
        "amount": {
          "number_format": {
            "minimumFractionDigits": 0,
            "maximumFractionDigits": 0
          }
        }
      },
      "plugin": "Datagrid",
      "plugin_config": {},
      "settings": false,
      // "table": "QQkUcmdrRFiosZRGLwydV",
      "theme": "Pro Light",
      "title": "balance sheet view",
      "group_by": [
        "instrumentsubtype",
        "country",
        "isin"
      ],
      "split_by": [
        "asset_or_liability"
      ],
      "sort": [],
      "filter": [],
      "group_rollup_mode": "rollup",
      "expressions": {},
      "columns": [
        "amount"
      ],
      "aggregates": {}
    },

  llmEndpoint: localStorage.getItem("rf.llmEndpoint") ?? "/api/chat"   // → Python backend (server.py)
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
  //  suggestions: ["Amount by businessline", "Compare countries", "Asset vs liability split", "Top counterparties"],
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
  state.worker = await perspective.worker();

  // Mock data — later this fetch can be driven by the chat context instead.
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Could not load ${DATA_URL} (HTTP ${response.status})`);
  const data = await response.text();
  state.table = await state.worker.table(data);
  await window.table_viewer.load(state.table);
  await table_viewer.restore(state.currentViewConfig);

  state.summary = computeSummary(data);
  $("context-chip").textContent = `Table: ${DATA_URL}`;
}

/** Pre-computed dataset stats from the raw CSV, fed to the LLM as context. */
function computeSummary(csvText) {
  const [header, ...lines] = csvText.trim().split(/\r?\n/);
  const cols = header.split(",");
  const blIdx = cols.indexOf("businessline");
  const amtIdx = cols.indexOf("amount");
  const byBusinessline = {};
  let totalAmount = 0;
  for (const line of lines) {
    const cells = line.split(",");            // mock CSV has no quoted commas
    const amount = Number(cells[amtIdx]) || 0;
    byBusinessline[cells[blIdx]] = (byBusinessline[cells[blIdx]] ?? 0) + amount;
    totalAmount += amount;
  }
  return { totalAmount, byBusinessline };
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
 * dataset schema, current table view configuration, summary stats, recent chat.
 */
function buildChatContext() {
  return {
    schema: {
      isin: "string",
      instrumentsubtype: "string",
      country: "string",
      businessline: "string",
      signoffgroup: "string",
      portfolionumber: "string",
      counterpartycode: "string",
      asset_or_liability: "string",
      amount: "float",
    },
    currentView: state.currentViewConfig,
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
   ▶ THIS IS WHERE THE APP TALKS TO YOUR LLM ENGINE (context + RAG).

   By default prompts are POSTed to /api/chat — the Python backend
   (server.py), which forwards them to PlaceholderLLM.chat() in llm.py.
   Override the URL via the ⚙ Settings popover. Suggested contract:

     POST <state.llmEndpoint>            (default: /api/chat → server.py/llm.py)
     { "prompt":  string,                  // raw user prompt from the chat
       "context": buildChatContext() }     // schema + current view + summary
                                           // + recent conversation history
     → response:
     { "answer":    string,                // text displayed in the chat
       "dashboard": {                      // OPTIONAL — drives points #2 + #3
         "plugin":     "Datagrid",         // the data table is the only viewer
         "group_by":   ["businessline"],   // Perspective group_by (row pivots)
         "columns":    ["amount"],         // numeric columns to aggregate
         "aggregates": { "amount": "sum" }
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

  // ── FALLBACK MOCK — used when the endpoint is unreachable (e.g. the page ──
  // ── is served statically, without server.py) ─────────────────────────────
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

  const VALID_PLUGINS = new Set(["Datagrid"]);   // table-only workspace
  const VALID_COLUMNS = new Set([
    "isin", "instrumentsubtype", "country", "businessline", "signoffgroup",
    "portfolionumber", "counterpartycode", "asset_or_liability", "amount",
  ]);

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
   Applies the LLM-chosen configuration to the data-table viewer.

   ▶ If your RAG pipeline returns NEW DATA (filtered rows, another dataset),
     replace the rows here instead — the viewer will refresh automatically:
         await state.table.replace(newCsvOrJson);
   ═══════════════════════════════════════════════════════════════════════════ */
async function updateDashboardFromContext(config) {
  state.currentViewConfig = { ...state.currentViewConfig, ...config };
  await $("table_viewer").restore(state.currentViewConfig);
}

/* ── mock LLM (placeholder until point #1 is wired to a real endpoint) ───────
   Keyword-based canned answers, grounded in the REAL summary stats computed
   from the dataset, so the demo already feels alive. Delete this when your
   RAG workflow is plugged in.                                              */
function mockLLMResponse(prompt, context) {
  const p = prompt.toLowerCase();
  const s = context.summary;
  const top = (obj) => Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1])[0] ?? ["—", 0];

  if (p.includes("businessline")) {
    const [best, val] = top(s?.byBusinessline);
    return {
      answer: `Here is amount by businessline: ${best} leads with ${money.format(val)} out of ${money.format(s?.totalAmount ?? 0)} total.`,
      dashboard: { plugin: "Datagrid", group_by: ["businessline"], columns: ["amount"], aggregates: { amount: "sum" } },
    };
  }
  return {
    answer: `I'm not exploring.`,
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
