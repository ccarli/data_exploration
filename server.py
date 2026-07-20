#!/usr/bin/env python3
"""R&F data explorer — Python backend (zero dependencies, stdlib only).

Serves two things on http://localhost:8000 :

  • the static frontend (index.html / app.js / styles.css / mock_data.csv)
  • POST /api/chat — the pipe between the chat UI and a Python LLM object

The LLM itself lives in llm.py (PlaceholderLLM) — that's the file to replace
with your real engine. This server is just plumbing and shouldn't need to
change.

Run:  python3 server.py        (set the PORT env var to use another port)
"""

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm import PlaceholderLLM

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))

# One shared LLM instance for the whole process — swap the class in llm.py,
# keep the contract (see the docstring there).
llm = PlaceholderLLM()


class Handler(SimpleHTTPRequestHandler):
    """Static files (inherited from SimpleHTTPRequestHandler) + a tiny JSON API."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ── API: POST /api/chat ─────────────────────────────────────────────────
    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404, "Unknown endpoint")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            prompt = payload.get("prompt")
            context = payload.get("context") or {}
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError('Body must be JSON with a non-empty "prompt" string.')

            # ──▶ THE PIPE — one call, from HTTP body to the Python LLM object.
            result = llm.chat(prompt, context)

            if not isinstance(result, dict) or not isinstance(result.get("answer"), str):
                raise TypeError("llm.chat() must return a dict with an 'answer' string.")
            self._send_json({"answer": result["answer"], "dashboard": result.get("dashboard")})
        except (ValueError, json.JSONDecodeError) as err:
            self._send_json({"error": f"Bad request: {err}"}, status=400)
        except Exception as err:  # surface LLM errors as JSON — never kill the server
            self._send_json({"error": f"LLM backend error: {err}"}, status=500)

    # ── API: GET /api/health — quick "is the backend up?" check ─────────────
    def do_GET(self):
        if self.path == "/api/health":
            self._send_json({"status": "ok", "llm": type(llm).__name__})
            return
        super().do_GET()  # static files

    # ── CORS (only matters if you ever serve the frontend from another origin)
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"R&F data explorer — backend up on http://localhost:{PORT}")
    print(f"  • UI       → http://localhost:{PORT}/")
    print(f"  • chat API → POST /api/chat  (LLM: {type(llm).__name__} — see llm.py)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye!")
