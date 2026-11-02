"""
Tiny OpenAI-compatible proxy for the Autonomous Intersection sim.

Why: keeps your API key on the server instead of in the browser, and logs every batch call.
The browser still makes exactly ONE request per tick -> this proxy makes exactly ONE upstream request.

Run:
  pip install fastapi uvicorn httpx
  export UPSTREAM_BASE=https://api.groq.com/openai/v1   # any OpenAI-compatible endpoint
  export UPSTREAM_KEY=gsk_...
  export UPSTREAM_MODEL=llama-3.3-70b-versatile          # optional override
  uvicorn proxy:app --port 8787
Then in the app choose provider "Own proxy server" with base http://localhost:8787 .

If UPSTREAM_BASE is not set, the proxy falls back to the Anthropic / OpenAI SDKs using
environment credentials (used by the authors for test recordings).
"""
import os
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Intersection LLM proxy")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

UPSTREAM_BASE = os.getenv("UPSTREAM_BASE")
UPSTREAM_KEY = os.getenv("UPSTREAM_KEY", "")
UPSTREAM_MODEL = os.getenv("UPSTREAM_MODEL")
DEFAULT_SDK_MODEL = os.getenv("SDK_MODEL", "claude_haiku_4_5")
calls = {"n": 0}


def _sdk_complete(model: str, system: str, user: str) -> str:
    if model.startswith(("claude", "gemini", "grok")):
        from anthropic import Anthropic
        msg = Anthropic(default_headers={"anthropic-version": "2023-06-01"}).messages.create(model=model, max_tokens=4000, system=system,
                                          messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    from openai import OpenAI
    r = OpenAI().responses.create(model=model, instructions=system, input=user)
    return r.output_text


@app.post("/chat/completions")
async def chat(req: Request):
    body = await req.json()
    calls["n"] += 1
    t0 = time.time()
    if UPSTREAM_BASE:
        if UPSTREAM_MODEL:
            body["model"] = UPSTREAM_MODEL
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(UPSTREAM_BASE.rstrip("/") + "/chat/completions", json=body,
                             headers={"Authorization": f"Bearer {UPSTREAM_KEY}"})
        print(f"call #{calls['n']} {r.status_code} {(time.time()-t0)*1000:.0f} ms")
        return r.json()
    system = next((m["content"] for m in body["messages"] if m["role"] == "system"), "")
    user = next((m["content"] for m in body["messages"] if m["role"] == "user"), "")
    model = body.get("model") if body.get("model") not in (None, "", "default") else DEFAULT_SDK_MODEL
    import asyncio
    text = await asyncio.to_thread(_sdk_complete, model, system, user)
    print(f"call #{calls['n']} {model} {(time.time()-t0)*1000:.0f} ms")
    return {"choices": [{"message": {"role": "assistant", "content": text}}], "model": model}


@app.get("/health")
def health():
    return {"ok": True, "calls": calls["n"], "upstream": UPSTREAM_BASE or "sdk"}
