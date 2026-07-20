# R&F data explorer

One-page webapp — plain HTML/CSS/JS, no build step — pairing an AI chat
assistant with a [Perspective (FINOS)](https://perspective.finos.org/) dashboard.

## Run it

```bash
cd data_exploration/html_ui_psp
python3 server.py
# then open http://localhost:8000  (set the PORT env var to change the port)
```

`server.py` (zero dependencies, stdlib only) serves the static frontend **and**
the `/api/chat` endpoint that pipes chat prompts to the Python LLM object in
`llm.py`.

> No backend? `python3 -m http.server 8000` still works for the UI alone —
> `/api/chat` then 404s and the chat silently falls back to the built-in JS
> mock.
>
> ⚠ The Perspective library is loaded from the **jsDelivr CDN** — an internet
> connection is required at runtime. If it can't be reached, a warning banner
> appears in the app.

## Files

| File            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `index.html`    | Page structure: header / chat panel / dashboard / footer       |
| `styles.css`    | Design tokens, layout, components, responsive rules            |
| `app.js`        | Perspective setup, chat logic, **LLM integration points**      |
| `mock_data.csv` | 1000 rows of simulated data: `isin, instrumentsubtype, country, businessline, signoffgroup, portfolionumber, counterpartycode, asset_or_liability, amount` |
| `server.py`     | Python backend: statics + `POST /api/chat` (zero dependencies) |
| `llm.py`        | **Placeholder LLM object** — replace it with your engine       |

## LLM integration (the part to refine manually)

Search `app.js` for **`LLM INTEGRATION POINT`** — there are three:

1. **`queryLLM(prompt, context)`** — sends the user prompt plus app context
   (dataset schema, current view config, summary stats, recent history) to the
   LLM. By default it POSTs to **`/api/chat`**, served by `server.py`, which
   forwards to `PlaceholderLLM.chat()` in **`llm.py`** — that Python object is
   where your RAG-enhanced engine plugs in (keep the contract documented at
   the top of `llm.py`). You can override the URL from the **⚙ Settings**
   popover (persisted in `localStorage`); if the endpoint is unreachable, the
   built-in JS mock answers. Backend replies are prefixed *[python]* so you
   can tell which side answered.

   Suggested contract:
   ```jsonc
   // POST <endpoint>
   { "prompt": "...", "context": { "schema": {}, "currentView": {}, "summary": {}, "history": [] } }
   // → response
   { "answer": "text shown in chat",
     "dashboard": { "plugin": "Datagrid", "group_by": ["businessline"],
                    "columns": ["amount"], "aggregates": { "amount": "sum" } } }
   ```

2. **`extractDashboardConfig(llmResponse, prompt)`** — turns the LLM response
   into a Perspective view configuration (validates plugin/column names).

3. **`updateDashboardFromContext(config)`** — applies that configuration to the
   data-table viewer. To push **new rows** instead (e.g. RAG-retrieved data),
   call `state.table.replace(newData)` here.

## Manual test checklist

- [ ] Header shows title, date, settings ⚙, profile avatar
- [ ] Chat greeting: *"hello Clement, what do you want to explore today?"* + suggestion chips
- [ ] Sending a prompt shows a typing indicator, then a mock answer
- [ ] With `server.py` running, answers are prefixed *[python]* (placeholder LLM in `llm.py`)
- [ ] Prompts like *"amount by businessline"*, *"compare countries"*, *"asset vs liability split"* reconfigure the table
- [ ] Divider drags between 25 %–60 %; double-click resets to 40 %; arrow keys work when focused
- [ ] Scroll-up in chat reveals the "scroll to latest" button
- [ ] Layout stacks vertically below ~900 px
