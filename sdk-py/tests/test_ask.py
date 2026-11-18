import os

import pytest

from conftest import AskEngine, GuardEngine
from unstuck import AskAnswer, AskResult, Unstuck, UnstuckConfigError, UnstuckEngineError


async def test_ask_answer(tmp_path):
    engine = AskEngine(tmp_path)
    links, other = [], []
    async with Unstuck(engine_path=engine.path, on_link=other.append) as u:
        result = await u.ask("Ship it?", choices=["Yes", "No"], details="v2", timeout_s=60, on_link=links.append)
    assert result == AskResult(status="answered", answer=AskAnswer(choice=1, label="No", text=None), via="page", duration_s=4.5, session_id="s1", detail=None)
    sent = engine.calls("ask")[0]
    assert sent["question"] == "Ship it?" and sent["choices"] == ["Yes", "No"] and sent["details"] == "v2" and sent["timeoutS"] == 60
    assert sent["private"] is True and "allowText" not in sent and sent["linkId"].startswith("ask-")
    # Only the link echoing this ask's linkId arrives (the "other" one is ignored), and nothing goes to the client's on_link.
    assert [(l.url, l.code, l.reason) for l in links] == [("https://x.example/a#t=1", "123456", "Ship it?")] and other == []
    assert engine.calls("engine.hello")[0]["protocolMinor"] == 2


async def test_ask_default_link_printer(tmp_path, capsys):
    async with Unstuck(engine_path=AskEngine(tmp_path).path) as u:
        await u.ask("Name?")
    assert "https://x.example/a#t=1" in capsys.readouterr().err


async def test_ask_text_answer_and_client_on_link(tmp_path):
    reply = {"result": {"status": "timed_out", "durationS": 10, "sessionId": "s2", "detail": "nobody"}}
    links = []
    async with Unstuck(engine_path=AskEngine(tmp_path, reply).path, on_link=links.append) as u:
        r = await u.ask("Name?", allow_text=True, private=False)
    assert r.status == "timed_out" and r.answer is None and r.via is None and r.detail == "nobody" and len(links) == 1


async def test_ask_engine_too_old(tmp_path):
    async with Unstuck(engine_path=GuardEngine(tmp_path, []).path) as u:
        with pytest.raises(UnstuckEngineError) as e:
            await u.ask("Hi?")
    assert str(e.value) == "this engine can't ask questions (needs @velmlabs/unstuck-engine 0.4.0 or later)"


@pytest.mark.parametrize(
    "q, kw, message",
    [
        ("", {}, "question must be 1-300 characters"),
        ("   ", {}, "question must be 1-300 characters"),
        ("x" * 301, {}, "question must be 1-300 characters"),
        ("Q", {"choices": ["only"]}, "choices must be 2-6 labels of at most 80 characters"),
        ("Q", {"choices": ["a"] * 7}, "choices must be 2-6 labels of at most 80 characters"),
        ("Q", {"choices": ["a", "x" * 81]}, "choices must be 2-6 labels of at most 80 characters"),
        ("Q", {"choices": ["a", " "]}, "choices must be 2-6 labels of at most 80 characters"),
        ("Q", {"allow_text": False}, "a question needs choices or allowText"),
        ("Q", {"choices": ["a", "b"], "details": "d" * 1001}, "details must be at most 1000 characters"),
        ("Q", {"timeout_s": 5}, "timeoutS must be 10-3600"),
        ("Q", {"timeout_s": 3601}, "timeoutS must be 10-3600"),
    ],
)
async def test_ask_bad_choices(tmp_path, q, kw, message):
    engine = AskEngine(tmp_path)
    async with Unstuck(engine_path=engine.path) as u:
        with pytest.raises(UnstuckConfigError) as e:
            await u.ask(q, **kw)
    assert str(e.value) == message and engine.calls("ask") == []


async def test_ask_engine_errors_map(tmp_path):
    for code, exc in (("bad_params", UnstuckConfigError), ("config_error", UnstuckConfigError)):
        reply = {"error": {"code": code, "message": f"no {code}"}}
        async with Unstuck(engine_path=AskEngine(tmp_path, reply).path) as u:
            with pytest.raises(exc, match=f"no {code}"):
                await u.ask("Q")
    from unstuck._rpc import RpcCallError

    async with Unstuck(engine_path=AskEngine(tmp_path, {"error": {"code": "boom", "message": "x"}}).path) as u:
        with pytest.raises(RpcCallError):
            await u.ask("Q")


async def test_ask_engine_exit(tmp_path):
    from conftest import write_engine

    body = """
import json, sys
for line in sys.stdin:
    m = json.loads(line)
    if m["method"] == "engine.hello":
        print(json.dumps({"id": m["id"], "result": {"engineVersion": "x", "protocolVersion": 1, "protocolMinor": 2, "capabilities": ["ask"]}}), flush=True)
    elif m["method"] == "ask":
        sys.exit(3)
"""
    async with Unstuck(engine_path=write_engine(tmp_path, body)) as u:
        with pytest.raises(UnstuckEngineError, match="engine exited with code 3"):
            await u.ask("Q")


async def test_concurrent_asks_get_their_own_links(tmp_path):
    import asyncio

    engine = AskEngine(tmp_path)
    a, b = [], []
    async with Unstuck(engine_path=engine.path) as u:
        await asyncio.gather(u.ask("A?", on_link=a.append), u.ask("B?", on_link=b.append))
    assert [l.reason for l in a] == ["A?"] and [l.reason for l in b] == ["B?"]
    ids = [c["linkId"] for c in engine.calls("ask")]
    assert len(set(ids)) == 2


async def test_agent_name_env(tmp_path, monkeypatch):
    from conftest import write_engine

    body = """
import json, os, sys
for line in sys.stdin:
    m = json.loads(line)
    if m["method"] == "engine.hello":
        print(json.dumps({"id": m["id"], "result": {"engineVersion": os.environ.get("UNSTUCK_AGENT_NAME", "unset"), "protocolVersion": 1}}), flush=True)
"""
    from unstuck._engine import spawn_engine

    monkeypatch.delenv("UNSTUCK_AGENT_NAME", raising=False)
    path = write_engine(tmp_path, body)
    e = await spawn_engine(path, agent_name="Booking bot")
    assert e.engine_version == "Booking bot"
    e.kill()
    await e.wait()
    e = await spawn_engine(path)
    assert e.engine_version == "unset"
    e.kill()
    await e.wait()
    # Unstuck(agent_name=...) hands it to the engine it spawns.
    async with Unstuck(engine_path=path, agent_name="Bot") as u:
        engine = await u._ensure_engine()
        assert engine.engine_version == "Bot"
