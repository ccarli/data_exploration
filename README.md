# data explorer

One-page webapp — plain HTML/CSS/JS, no build step — pairing an AI chat
assistant with a [Perspective (FINOS)](https://perspective.finos.org/) dashboard.

## Run it

ES modules and `fetch()` require an HTTP origin, so serve the folder
(don't open `index.html` via `file://`):

```bash
cd data_exploration
python3 -m http.server 8000
# then open http://localhost:8000
```

> ⚠ The Perspective library is loaded from the **jsDelivr CDN** — an internet
> connection is required at runtime. If it can't be reached, a warning banner
> appears in the app.

## Files

| File            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `index.html`    | Page structure: header / chat panel / dashboard / footer       |
| `styles.css`    | Design tokens, layout, components, responsive rules            |
| `app.js`        | Perspective setup, chat logic, **LLM integration points**      |
| `mock_data.csv` | 208 rows of simulated data: `date, region, desk, revenue, volume` |

## LLM integration (the part to refine manually)

Search `app.js` for **`LLM INTEGRATION POINT`** — there are three:

1. **`queryLLM(prompt, context)`** — sends the user prompt plus app context
   (dataset schema, current view config, summary stats, recent history) to the
   LLM. Today it returns a keyword-based mock; point it to your RAG-enhanced
   endpoint instead. You can set the endpoint URL from the **⚙ Settings**
   popover in the header (persisted in `localStorage`) — until then, or if the
   endpoint is unreachable, the mock answers.

   Suggested contract:
   ```jsonc
   // POST <endpoint>
   { "prompt": "...", "context": { "schema": {}, "currentView": {}, "summary": {}, "history": [] } }
   // → response
   { "answer": "text shown in chat",
     "dashboard": { "plugin": "Y Bar", "group_by": ["region"],
                    "columns": ["revenue"], "aggregates": { "revenue": "sum" } } }
   ```

2. **`extractDashboardConfig(llmResponse, prompt)`** — turns the LLM response
   into a Perspective view configuration (validates plugin/column names).

3. **`updateDashboardFromContext(config)`** — applies that configuration to the
   chart viewer (the table viewer shares the same Perspective table, so both
   stay in sync). To push **new rows** instead (e.g. RAG-retrieved data), call
   `state.table.replace(newData)` here.

## Manual test checklist

- [ ] Header shows title, date, settings ⚙, profile avatar
- [ ] Chat greeting: *"hello Clement, what do you want to explore today?"* + suggestion chips
- [ ] Sending a prompt shows a typing indicator, then a mock answer
- [ ] Prompts like *"revenue by region"*, *"compare desks"*, *"volume trend"* reconfigure the chart
- [ ] Chart and table stay in sync (same underlying table)
- [ ] Divider drags between 25 %–60 %; double-click resets to 40 %; arrow keys work when focused
- [ ] Scroll-up in chat reveals the "scroll to latest" button
- [ ] Layout stacks vertically below ~900 px
