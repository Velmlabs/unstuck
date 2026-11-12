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
