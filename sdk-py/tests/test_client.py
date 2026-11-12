import asyncio
import os
import subprocess
import sys
import textwrap
import time

import pytest

from conftest import ENGINE, scripted_engine, write_engine
from unstuck import TakeoverResult, Unstuck, UnstuckEngineError


async def wait_for(pred, timeout=10.0):
    t0 = time.monotonic()
    while not pred():
        if time.monotonic() - t0 > timeout:
            raise AssertionError("condition not met")
        await asyncio.sleep(0.05)


async def test_link_then_done_resolves(browser):
    page = await browser.new_page()
    await page.set_content("<p>hello</p>")
    links = []
    async with Unstuck(engine_path=str(ENGINE), on_link=links.append) as u:
        task = asyncio.ensure_future(u.takeover(page, reason="Solve it", timeout_s=30))
        await wait_for(lambda: links)
        assert links[0].reason == "Solve it"
        assert links[0].url.startswith("http://127.0.0.1:") and "#t=" in links[0].url
        human = await browser.new_page()
        await human.goto(links[0].url)
        await human.get_by_role("button", name="Done").click()
        result = await task
        assert isinstance(result, TakeoverResult) and result.status == "resolved"
        assert result.session_id == links[0].session_id
        await human.close()
    await page.close()


async def test_page_closed_mid_takeover_returns_failed_quickly(browser):
    page = await browser.new_page()
    async with Unstuck(engine_path=str(ENGINE), on_link=lambda l: None) as u:
        task = asyncio.ensure_future(u.takeover(page, reason="x", timeout_s=60))
        await asyncio.sleep(0.5)
        t0 = time.monotonic()
        await page.close()
        result = await task
        assert (result.status, result.detail) == ("failed", "page_closed")
        assert time.monotonic() - t0 < 1


async def test_already_closed_page_returns_failed_without_an_engine(browser):
    page = await browser.new_page()
    await page.close()
    result = await Unstuck(engine_path="/nonexistent/unstuck-engine").takeover(page, reason="x")
    assert result == TakeoverResult(status="failed", session_id="", url="", duration_s=0, detail="page_closed")


async def test_page_closing_while_engine_starts_returns_failed(browser, tmp_path):
    page = await browser.new_page()
    slow = write_engine(
        tmp_path,
        """
        import json, sys, time
        for line in sys.stdin:
            m = json.loads(line)
            if m.get("method") == "engine.hello":
                time.sleep(0.8)
                sys.stdout.write(json.dumps({"id": m["id"], "result": {"engineVersion": "slow", "protocolVersion": 1}}) + "\\n"); sys.stdout.flush()
            elif m.get("method") == "shutdown":
                sys.stdout.write(json.dumps({"id": m["id"], "result": {}}) + "\\n"); sys.stdout.flush(); sys.exit(0)
        """,
    )
    u = Unstuck(engine_path=slow, on_link=lambda l: None)
    task = asyncio.ensure_future(u.takeover(page, reason="x", timeout_s=60))
    await asyncio.sleep(0.2)
    await page.close()
    t0 = time.monotonic()
    result = await task
    assert (result.status, result.detail) == ("failed", "page_closed")
    assert time.monotonic() - t0 < 2
    await u.close()


async def test_default_on_link_prints_to_stderr(browser, capsys):
    page = await browser.new_page()
    async with Unstuck(engine_path=str(ENGINE)) as u:
        result = await u.takeover(page, reason="Need a human", timeout_s=1)
    assert result.status == "timed_out"
    assert "Unstuck: a human is needed (Need a human) → http://127.0.0.1:" in capsys.readouterr().err
    await page.close()


async def test_missing_engine_raises(browser):
    page = await browser.new_page()
    with pytest.raises(UnstuckEngineError) as info:
        await Unstuck(engine_path="/nonexistent/unstuck-engine").takeover(page, reason="x")
    assert "/nonexistent/unstuck-engine" in str(info.value) and "UNSTUCK_ENGINE_PATH" in str(info.value)
    await page.close()


async def test_engine_dying_mid_takeover_raises_then_respawns(browser, tmp_path):
    page = await browser.new_page()
    (tmp_path / "a").mkdir()
    u = Unstuck(engine_path=scripted_engine(tmp_path / "a", "sys.exit(7)"), on_link=lambda l: None)
    with pytest.raises(UnstuckEngineError, match="^engine exited with code 7$"):
        await u.takeover(page, reason="x")
    (tmp_path / "b").mkdir()
    u._engine_path = scripted_engine(
        tmp_path / "b", 'out({"id": m["id"], "result": {"status": "resolved", "sessionId": "s", "url": "u", "durationS": 0}})'
    )
    assert (await u.takeover(page, reason="x")).status == "resolved"
    await u.close()
    await page.close()


async def test_unknown_page_ids_get_errors_not_hangs(browser, tmp_path):
    page = await browser.new_page()
    engine = scripted_engine(
        tmp_path,
        """
        pending = m["id"]
        out({"id": 900, "method": "cdp.send", "params": {"pageId": "nope", "method": "Runtime.evaluate"}})
        out({"id": 901, "method": "cdp.subscribe", "params": {"pageId": "nope", "events": ["X"]}})
        for l2 in sys.stdin:
            r = json.loads(l2)
            if r.get("id") == 900 and "error" in r:
                out({"id": pending, "result": {"status": "failed", "sessionId": "s", "url": "u", "durationS": 0, "detail": r["error"]["message"]}})
                break
        """,
    )
    async with Unstuck(engine_path=engine, on_link=lambda l: None) as u:
        result = await u.takeover(page, reason="x")
    assert (result.status, result.detail) == ("failed", "unknown page nope")
    await page.close()


async def test_close_without_takeover_is_a_no_op():
    await Unstuck(engine_path=str(ENGINE)).close()


async def test_close_kills_an_engine_that_ignores_shutdown(browser, tmp_path):
    stubborn = write_engine(
        tmp_path,
        """
        import json, sys, time
        for line in sys.stdin:
            m = json.loads(line)
            if m.get("method") == "engine.hello":
                sys.stdout.write(json.dumps({"id": m["id"], "result": {"engineVersion": "x", "protocolVersion": 1}}) + "\\n"); sys.stdout.flush()
        while True: time.sleep(1)
        """,
    )
    page = await browser.new_page()
    u = Unstuck(engine_path=stubborn, on_link=lambda l: None)
    task = asyncio.ensure_future(u.takeover(page, reason="x"))
    await asyncio.sleep(0.5)
    t0 = time.monotonic()
    await u.close()
    assert time.monotonic() - t0 < 3.5
    with pytest.raises(UnstuckEngineError):
        await task
    await page.close()


CHILD = textwrap.dedent(
    """
    import asyncio, sys
    from playwright.async_api import async_playwright
    from unstuck import Unstuck, UnstuckEngineError

    async def main(kill):
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()
            u = Unstuck(on_link=lambda l: None)
            if kill:
                task = asyncio.ensure_future(u.takeover(page, reason="x", timeout_s=30))
                await asyncio.sleep(1)
                (await u._engine).kill()
                try:
                    await task
                except UnstuckEngineError:
                    print("engine_error")
            else:
                print((await u.takeover(page, reason="x", timeout_s=1)).status)
            await u.close()
            await browser.close()

    asyncio.run(main(sys.argv[1] == "kill"))
    """
)


@pytest.mark.parametrize("mode,expected", [("timeout", "timed_out"), ("kill", "engine_error")])
def test_review_focus_1_agent_process_exits_cleanly(mode, expected):
    env = {**os.environ, "UNSTUCK_ENGINE_PATH": str(ENGINE)}
    proc = subprocess.run([sys.executable, "-c", CHILD, mode], env=env, capture_output=True, text=True, timeout=15)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == expected
    assert "Task was destroyed but it is pending" not in proc.stderr
    assert "Exception ignored" not in proc.stderr
