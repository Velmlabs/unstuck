import os
import re
import time
from pathlib import Path

import pytest

import unstuck
from conftest import ENGINE, write_engine
from unstuck import UnstuckEngineError
from unstuck._engine import resolve_engine_path, spawn_engine


def test_lookup_prefers_explicit_then_env():
    assert resolve_engine_path("/a", {"UNSTUCK_ENGINE_PATH": "/b"}) == "/a"
    assert resolve_engine_path(None, {"UNSTUCK_ENGINE_PATH": "/b"}) == "/b"


def test_lookup_falls_back_to_bundled_binary(monkeypatch, tmp_path):
    bundled = tmp_path / "_bin" / "unstuck-engine"
    bundled.parent.mkdir()
    bundled.write_text("")
    monkeypatch.setattr("unstuck._engine._bundled_path", lambda: bundled)
    assert resolve_engine_path(None, {}) == str(bundled)


def test_lookup_error_names_everything_it_tried(monkeypatch, tmp_path):
    monkeypatch.setattr("unstuck._engine._bundled_path", lambda: tmp_path / "missing")
    with pytest.raises(UnstuckEngineError) as info:
        resolve_engine_path(None, {})
    msg = str(info.value)
    assert "engine_path" in msg and "UNSTUCK_ENGINE_PATH" in msg and str(tmp_path / "missing") in msg


def test_bundled_path_lives_inside_the_package():
    from unstuck._engine import _bundled_path

    assert _bundled_path().parent == Path(unstuck.__file__).parent / "_bin"


async def test_real_engine_handshake():
    e = await spawn_engine(str(ENGINE))
    assert re.match(r"^\d+\.\d+\.\d+", e.engine_version)
    e.kill()
    await e.wait()


async def test_host_and_port_are_passed_through(tmp_path):
    echo = write_engine(
        tmp_path,
        """
        import json, sys
        for line in sys.stdin:
            m = json.loads(line)
            sys.stdout.write(json.dumps({"id": m["id"], "result": {"engineVersion": " ".join(sys.argv[1:]), "protocolVersion": 1}}) + "\\n"); sys.stdout.flush()
        """,
    )
    e = await spawn_engine(echo, host="0.0.0.0", port=4321)
    assert e.engine_version == "--stdio --host 0.0.0.0 --port 4321"
    e.kill()
    await e.wait()


async def test_missing_binary_fails_fast_naming_the_path():
    t0 = time.monotonic()
    with pytest.raises(UnstuckEngineError) as info:
        await spawn_engine("/nonexistent/unstuck-engine")
    assert time.monotonic() - t0 < 2
    assert "/nonexistent/unstuck-engine" in str(info.value) and "UNSTUCK_ENGINE_PATH" in str(info.value)
    assert info.value.engine_path == "/nonexistent/unstuck-engine"


async def test_exit_before_hello(tmp_path):
    with pytest.raises(UnstuckEngineError) as info:
        await spawn_engine(write_engine(tmp_path, "import sys; sys.exit(3)"))
    assert "exited with code 3 before the handshake" in str(info.value)
    assert "UNSTUCK_ENGINE_PATH" in str(info.value)


async def test_silent_engine_times_out_and_is_killed(tmp_path):
    t0 = time.monotonic()
    with pytest.raises(UnstuckEngineError) as info:
        await spawn_engine(write_engine(tmp_path, "import time\nwhile True: time.sleep(1)"), handshake_timeout_s=0.3)
    assert "did not answer the handshake within 0.3 s" in str(info.value)
    assert "UNSTUCK_ENGINE_PATH" in str(info.value)
    assert time.monotonic() - t0 < 3


async def test_protocol_mismatch(tmp_path):
    bad = write_engine(
        tmp_path,
        """
        import json, sys
        for line in sys.stdin:
            m = json.loads(line)
            sys.stdout.write(json.dumps({"id": m["id"], "error": {"code": "protocol_mismatch", "message": "old engine"}}) + "\\n"); sys.stdout.flush()
        """,
    )
    with pytest.raises(UnstuckEngineError) as info:
        await spawn_engine(bad)
    assert "refused the handshake: old engine" in str(info.value) and "UNSTUCK_ENGINE_PATH" in str(info.value)


async def test_engine_exit_closes_the_rpc_channel(tmp_path):
    from unstuck._rpc import RpcCallError

    from conftest import scripted_engine

    e = await spawn_engine(scripted_engine(tmp_path, "sys.exit(7)"))
    with pytest.raises(RpcCallError) as info:
        await e.peer.request("takeover", {})
    assert info.value.code == "closed" and "exited with code 7" in str(info.value)
    assert await e.wait() == 7
