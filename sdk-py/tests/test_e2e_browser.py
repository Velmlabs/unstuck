"""Unstuck Browser end to end in Python: a wrapped async Playwright page meets a Cloudflare challenge, the engine binary
detects it and serves the link, and a phone-sized person taps Done."""

import asyncio
import http.server
import threading

import pytest
import pytest_asyncio

from conftest import ENGINE, REPO
from unstuck import Unstuck, UnstuckRescueError

INTERSTITIAL = (REPO / "core" / "test" / "fixtures" / "human-checks" / "cloudflare-interstitial.html").read_text()
WATCH = (
    "<script>const t = setInterval(() => fetch('/__state').then((r) => r.text()).then((s) => "
    "{ if (s === 'solved') { clearInterval(t); setTimeout(() => location.reload(), 1000); } }), 200);</script>"
)
SHOP = b"<!doctype html><title>Shop</title><h1>Shop</h1><p>Welcome to the shop.</p>"


@pytest_asyncio.fixture
async def challenge_site():
    state = {"solved": False}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib naming
            if self.path == "/__state":
                self._send(200, b"solved" if state["solved"] else b"waiting", "text/plain")
            elif "cf_clearance=e2e" in (self.headers.get("cookie") or "") or state["solved"]:
                self._send(200, SHOP, extra={"set-cookie": "cf_clearance=e2e; Path=/"})
            else:
                self._send(503, INTERSTITIAL.replace("</body>", WATCH + "</body>").encode(), extra={"cf-mitigated": "challenge"})

        def _send(self, status, body, ctype="text/html; charset=utf-8", extra=None):
            self.send_response(status)
            self.send_header("content-type", ctype)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    state["url"] = f"http://127.0.0.1:{server.server_address[1]}/cf"
    yield state
    server.shutdown()


async def act_as_human(pw, url):
    browser = await pw.chromium.launch()
    try:
        ctx = await browser.new_context(**pw.devices["iPhone 13"])
        human = await ctx.new_page()
        await human.goto(url)
        await human.get_by_role("button", name="Start takeover").click()
        await human.wait_for_function("() => document.querySelector('canvas')?.width > 300", timeout=60000)
        await human.get_by_role("button", name="Done").click()
        await human.wait_for_timeout(500)
    finally:
        await browser.close()


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("UNSTUCK_HOME", str(tmp_path / "home"))


async def test_wrap_resolves_a_cloudflare_challenge(pw, challenge_site):
    people = []

    def on_link(link):
        challenge_site["solved"] = True
        people.append(asyncio.ensure_future(act_as_human(pw, link.url)))

    browser = await pw.chromium.launch()
    try:
        async with Unstuck(engine_path=str(ENGINE), on_link=on_link) as u:
            page = u.wrap(await browser.new_page())
            await page.goto(challenge_site["url"])
            assert await page.title() == "Shop"
            assert page.unstuck.last_rescue.status == "resolved" and page.unstuck.last_rescue.check.vendor == "cloudflare"
            session = await page.unstuck.get_session()
            assert "cf_clearance=e2e" in session.cookie_header
            await asyncio.gather(*people)
    finally:
        await browser.close()


async def test_rate_limit_raises_rescue_limited(pw, challenge_site):
    links = []
    browser = await pw.chromium.launch()
    try:
        async with Unstuck(engine_path=str(ENGINE), on_link=links.append) as u:
            page = u.wrap(await browser.new_page(), max_rescues_per_hour=1, timeout_s=10)
            with pytest.raises(UnstuckRescueError) as first:
                await page.goto(challenge_site["url"])  # nobody comes: timed out
            assert first.value.status == "timed_out"
            with pytest.raises(UnstuckRescueError) as second:
                await page.goto(challenge_site["url"])
            assert second.value.status == "rescue_limited" and "at most 1 person-checks per hour" in second.value.detail
            assert len(links) == 1
    finally:
        await browser.close()
