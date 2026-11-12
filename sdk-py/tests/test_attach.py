import asyncio
import re

import pytest

from unstuck import PageClosedError
from unstuck._attach import attach_page


async def test_attaches_and_sends(browser):
    page = await browser.new_page()
    a = await attach_page(page)
    assert re.match(r"^page-[a-z0-9-]+$", a.page_id)
    r = await a.send("Runtime.evaluate", {"expression": "1+1", "returnByValue": True})
    assert r["result"]["value"] == 2
    assert a.url() == "about:blank"
    await a.detach()
    await page.close()


async def test_subscribes_to_events(browser):
    page = await browser.new_page()
    a = await attach_page(page)
    got = []
    a.subscribe("Runtime.consoleAPICalled", got.append)
    await a.send("Runtime.enable")
    await page.evaluate("console.log('hi')")
    for _ in range(50):
        if got:
            break
        await asyncio.sleep(0.02)
    assert got
    await a.detach()
    await page.close()


async def test_reports_page_close_once_and_late_listeners_fire_immediately(browser):
    page = await browser.new_page()
    a = await attach_page(page)
    closed = []
    a.on_close(closed.append)
    await page.close()
    for _ in range(50):
        if closed:
            break
        await asyncio.sleep(0.02)
    assert closed == ["page closed"]
    late = []
    a.on_close(late.append)
    assert late == ["page closed"]
    await a.detach()


async def test_reports_crash(browser):
    page = await browser.new_page()
    a = await attach_page(page)
    closed = []
    a.on_close(closed.append)
    page._impl_obj.emit("crash", page._impl_obj)
    assert closed == ["page crashed"]
    await a.detach()
    await page.close()


async def test_already_closed_page_raises_page_closed(browser):
    page = await browser.new_page()
    await page.close()
    with pytest.raises(PageClosedError):
        await attach_page(page)


async def test_attach_failure_on_a_page_closing_underneath_is_page_closed():
    class Ctx:
        async def new_cdp_session(self, page):
            page.closed = True
            raise RuntimeError("Target closed")

    class FakePage:
        closed = False
        context = Ctx()

        def is_closed(self):
            return self.closed

    with pytest.raises(PageClosedError):
        await attach_page(FakePage())


async def test_other_attach_failures_propagate():
    class Ctx:
        async def new_cdp_session(self, page):
            raise RuntimeError("protocol error")

    class FakePage:
        context = Ctx()

        def is_closed(self):
            return False

    with pytest.raises(RuntimeError, match="protocol error"):
        await attach_page(FakePage())


@pytest.mark.parametrize("obj", [{}, None, object()])
async def test_rejects_non_pages(obj):
    with pytest.raises(TypeError, match="Unsupported page object: pass a Playwright Page"):
        await attach_page(obj)
