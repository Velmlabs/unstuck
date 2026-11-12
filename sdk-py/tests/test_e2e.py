"""End to end: a Python agent asks for help; an iPhone-sized human taps the fixture CAPTCHA and taps Done."""

import asyncio
import http.server
import threading

import pytest_asyncio

from conftest import ENGINE, FIXTURE_HTML
from unstuck import Unstuck


@pytest_asyncio.fixture
async def site():
    body = FIXTURE_HTML.read_bytes()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib naming
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


async def canvas_point(human, page_point):
    box = await human.locator("canvas").bounding_box()
    scale = min(box["width"] / 1280, box["height"] / 720)
    off_x = (box["width"] - 1280 * scale) / 2
    off_y = (box["height"] - 720 * scale) / 2
    return box["x"] + off_x + page_point[0] * scale, box["y"] + off_y + page_point[1] * scale


async def test_phone_human_solves_fixture_and_taps_done(pw, site):
    agent_browser = await pw.chromium.launch()
    human_browser = await pw.chromium.launch()
    page = await agent_browser.new_page(viewport={"width": 1280, "height": 720})
    await page.goto(site)
    link_ready = asyncio.Event()
    links = []

    def on_link(link):
        links.append(link)
        link_ready.set()

    async with Unstuck(engine_path=str(ENGINE), on_link=on_link) as u:
        task = asyncio.ensure_future(u.takeover(page, reason="Solve the test CAPTCHA", timeout_s=60))
        await asyncio.wait_for(link_ready.wait(), 15)
        ctx = await human_browser.new_context(**pw.devices["iPhone 13"])
        human = await ctx.new_page()
        await human.goto(links[0].url)
        await human.wait_for_function("() => document.querySelector('canvas')?.width > 100", timeout=15000)
        b = await page.locator("#robot").bounding_box()
        x, y = await canvas_point(human, (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2))
        await human.touchscreen.tap(x, y)
        for _ in range(100):
            if await page.evaluate("window.clicks") == 1:
                break
            await asyncio.sleep(0.05)
        assert await page.evaluate("window.clicks") == 1
        await human.get_by_role("button", name="Done").click()
        result = await asyncio.wait_for(task, 15)
        assert result.status == "resolved"
        await ctx.close()
    await agent_browser.close()
    await human_browser.close()
