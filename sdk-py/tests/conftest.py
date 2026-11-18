import pathlib

REPO = pathlib.Path(__file__).resolve().parents[2]
ENGINE = REPO / "engine" / "dist" / "unstuck-engine"
CASES = REPO / "protocol" / "cases" / "rpc.json"
FIXTURE_HTML = REPO / "e2e" / "fixtures" / "fake-captcha.html"

import os
import stat
import sys
import textwrap


def write_engine(tmp_path, body: str) -> str:
    """Writes an executable fake engine (a Python script) and returns its path."""
    path = tmp_path / "engine.py"
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


SCRIPTED = """
import json, sys
def out(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "engine.hello":
        out({"id": m["id"], "result": {"engineVersion": "fake", "protocolVersion": 1}})
    elif m.get("method") == "takeover":
        ON_TAKEOVER
    elif m.get("method") == "shutdown":
        out({"id": m["id"], "result": {}}); sys.exit(0)
"""


def scripted_engine(tmp_path, on_takeover: str) -> str:
    return write_engine(tmp_path, SCRIPTED.replace("ON_TAKEOVER", on_takeover))

import pytest_asyncio
from playwright.async_api import async_playwright


@pytest_asyncio.fixture
async def browser():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        yield b
        await b.close()


@pytest_asyncio.fixture
async def pw():
    async with async_playwright() as p:
        yield p


GUARD_ENGINE = """
import json, sys
OUTCOMES = json.loads(OUTCOMES_JSON)
CAPS = CAPS_JSON
LOG = LOG_PATH
PROBE = PROBE_FLAG
RESCUE_NOTES = NOTES_FLAG
next_id = [1000]
state = {"page": None}
def out(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
def log(m):
    with open(LOG, "a") as f:
        f.write(json.dumps(m) + "\\n")
def request(method, params):
    i = next_id[0]; next_id[0] += 1
    out({"id": i, "method": method, "params": params})
    for line in sys.stdin:
        r = json.loads(line)
        if r.get("id") == i and "method" not in r:
            log({"method": "<-" + method, "params": r})
            return r
        handle(r)
def handle(m):
    method = m.get("method")
    if method is None:
        return
    log(m)
    if "id" not in m:
        return  # a notification (cdp.closed, cdp.event)
    if method == "engine.hello":
        res = {"engineVersion": "fake-guard", "protocolVersion": 1}
        if CAPS is not None:
            res.update({"protocolMinor": 1, "capabilities": CAPS})
        out({"id": m["id"], "result": res})
    elif method == "guard.open":
        state["page"] = m["params"]["pageId"]
        if PROBE:
            created = request("page.create", {"pageId": m["params"]["pageId"]})
            tab = created["result"]["pageId"]
            request("cdp.send", {"pageId": tab, "method": "Runtime.evaluate", "params": {"expression": "1 + 1", "returnByValue": True}})
            request("page.close", {"pageId": tab})
            request("page.close", {"pageId": tab})
            request("page.create", {"pageId": "nope"})
        out({"id": m["id"], "result": {"guardId": "g1"}})
    elif method in ("guard.after", "guard.check", "guard.askHuman"):
        if RESCUE_NOTES:
            out({"method": "guard.rescue", "params": {"guardId": "g1", "pageId": state["page"], "active": True}})
            request("cdp.send", {"pageId": "nope", "method": "Runtime.evaluate", "params": {"expression": "0"}})
            out({"method": "guard.rescue", "params": {"guardId": "g1", "pageId": state["page"], "active": False}})
        out({"id": m["id"], "result": OUTCOMES.pop(0) if OUTCOMES else None})
    elif method == "guard.before":
        out({"id": m["id"], "result": None})
    elif method == "guard.getSession":
        out({"id": m["id"], "result": {"site": "shop.example", "userAgent": "UA/1", "cookieHeader": "cf_clearance=ok", "cookies": [
            {"name": "cf_clearance", "value": "ok", "domain": ".shop.example", "path": "/", "expires": -1, "httpOnly": True, "secure": True, "sameSite": "Lax"}]}})
    elif method in ("guard.rememberSite", "guard.forgetSite", "guard.forgetAll", "guard.close"):
        out({"id": m["id"], "result": {}})
    elif method == "shutdown":
        out({"id": m["id"], "result": {}}); sys.exit(0)
    else:
        out({"id": m["id"], "error": {"code": "unknown_method", "message": method}})
for line in sys.stdin:
    handle(json.loads(line))
"""


class GuardEngine:
    """A scripted engine that answers the guard methods; `calls(method)` lists the params it received."""

    def __init__(self, tmp_path, outcomes, capabilities=("guard", "paintCheck"), probe=False, rescue_notes=False) -> None:
        import json

        self.log = tmp_path / "calls.jsonl"
        body = (
            GUARD_ENGINE.replace("OUTCOMES_JSON", repr(json.dumps(list(outcomes))))
            .replace("CAPS_JSON", "None" if capabilities is None else repr(list(capabilities)))
            .replace("LOG_PATH", repr(str(self.log)))
            .replace("PROBE_FLAG", repr(probe))
            .replace("NOTES_FLAG", repr(rescue_notes))
        )
        self.path = write_engine(tmp_path, body)

    def entries(self):
        import json

        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def calls(self, method: str):
        return [e.get("params") for e in self.entries() if e["method"] == method]


ASK_ENGINE = """
import json, sys
CAPS = CAPS_JSON
LOG = LOG_PATH
REPLY = REPLY_JSON
def out(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    m = json.loads(line)
    with open(LOG, "a") as f:
        f.write(json.dumps(m) + "\\n")
    if m.get("method") == "engine.hello":
        res = {"engineVersion": "fake-ask", "protocolVersion": 1}
        if CAPS is not None:
            res.update({"protocolMinor": 2, "capabilities": CAPS})
        out({"id": m["id"], "result": res})
    elif m.get("method") == "ask":
        p = m["params"]
        if REPLY.get("error"):
            out({"id": m["id"], "error": REPLY["error"]})
            continue
        out({"method": "ask.link", "params": {"sessionId": "s1", "url": "https://x.example/a#t=1", "reason": p["question"], "expiresAt": 123, "linkId": "other"}})
        out({"method": "ask.link", "params": {"sessionId": "s1", "url": "https://x.example/a#t=1", "reason": p["question"], "expiresAt": 123, "linkId": p.get("linkId"), "code": "123456"}})
        out({"id": m["id"], "result": REPLY["result"]})
    elif m.get("method") == "shutdown":
        out({"id": m["id"], "result": {}}); sys.exit(0)
"""


class AskEngine:
    """A scripted engine that answers `ask` (and sends ask.link); `calls(method)` lists the params it received."""

    def __init__(self, tmp_path, reply=None, capabilities=("ask",)) -> None:
        import json

        self.log = tmp_path / "ask-calls.jsonl"
        reply = reply or {"result": {"status": "answered", "answer": {"choice": 1, "label": "No"}, "via": "page", "durationS": 4.5, "sessionId": "s1"}}
        body = (
            ASK_ENGINE.replace("CAPS_JSON", "None" if capabilities is None else repr(list(capabilities)))
            .replace("LOG_PATH", repr(str(self.log)))
            .replace("REPLY_JSON", repr(reply))
        )
        self.path = write_engine(tmp_path, body)

    def calls(self, method: str):
        import json

        if not self.log.exists():
            return []
        return [m.get("params") for m in (json.loads(line) for line in self.log.read_text().splitlines()) if m.get("method") == method]
