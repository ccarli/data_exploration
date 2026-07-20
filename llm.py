"""Placeholder LLM object — THIS is where your real engine plugs in.

`server.py` calls `llm.chat(prompt, context)` for every chat message.
Replace PlaceholderLLM with your own class (RAG workflow, function calling,
LangChain, OpenAI, a local model, …) — just keep the contract below.

──────────────────────────────── THE CONTRACT ─────────────────────────────────
chat(prompt: str, context: dict) -> {
    "answer":    str,              # displayed in the chat bubble
    "dashboard": {                 # OPTIONAL — reconfigures the data table
        "plugin":     "Datagrid",          # only "Datagrid" is allowed today
        "group_by":   ["businessline"],    # Perspective row pivots
        "columns":    ["amount"],          # columns to aggregate
        "aggregates": {"amount": "sum"},
    } | None,                      # None → leave the table as-is
}

`context` is buildChatContext() from app.js:
{
  "schema":      {"isin": "string", ..., "amount": "float"},  # 9 CSV columns
  "currentView": {"plugin": "Datagrid", ...},                 # live table config
  "summary":     {"totalAmount": float, "byBusinessline": {str: float}},
  "history":     [{"role": "user" | "assistant", "text": str}, ...],
}
───────────────────────────────────────────────────────────────────────────────
"""

# Column names of mock_data.csv. Dashboard configs are validated against the
# same list on the frontend (extractDashboardConfig in app.js) — stay within
# these names when your LLM builds "dashboard" objects.
COLUMNS = (
    "isin", "instrumentsubtype", "country", "businessline", "signoffgroup",
    "portfolionumber", "counterpartycode", "asset_or_liability", "amount",
)


def _euros(value: float) -> str:
    """Compact EUR formatting, mirroring the frontend's `money` formatter."""
    abs_v = abs(value)
    if abs_v >= 1e9:
        return f"€{value / 1e9:.1f}B"
    if abs_v >= 1e6:
        return f"€{value / 1e6:.1f}M"
    if abs_v >= 1e3:
        return f"€{value / 1e3:.1f}K"
    return f"€{value:.0f}"


class PlaceholderLLM:
    """Keyword-based stand-in, mirroring the frontend's built-in JS mock.

    "…businessline…" prompts get a REAL answer grounded in context["summary"]
    plus a dashboard config (proving the full pipe: prompt → context → answer
    → table reconfiguration). Everything else gets a canned echo.

    Every reply is prefixed with "[python]" so you can tell at a glance that
    the Python backend answered — not the JS fallback mock.
    """

    def chat(self, prompt: str, context: dict) -> dict:
        context = context or {}
        summary = context.get("summary") or {}

        if "businessline" in prompt.lower():
            by_bl = summary.get("byBusinessline") or {}
            best, val = max(by_bl.items(), key=lambda kv: kv[1], default=("—", 0.0))
            total = summary.get("totalAmount", 0.0)
            return {
                "answer": (
                    f"[python] amount by businessline: {best} leads with "
                    f"{_euros(val)} out of {_euros(total)} total."
                ),
                "dashboard": {
                    "plugin": "Datagrid",
                    "group_by": ["businessline"],
                    "columns": ["amount"],
                    "aggregates": {"amount": "sum"},
                },
            }

        return {
            "answer": (
                f"[python] placeholder LLM received: “{prompt}”. "
                "Replace PlaceholderLLM.chat() in llm.py with your engine."
            ),
            "dashboard": None,
        }
