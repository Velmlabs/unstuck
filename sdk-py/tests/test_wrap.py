import asyncio
from urllib.parse import urlparse

import pytest
import pytest_asyncio

from conftest import GuardEngine
from unstuck import HumanCheck, RescueEvent, SiteSession, StoredCookie, Unstuck, UnstuckEngineError, UnstuckRescueError

CF = {"kind": "challenge", "vendor": "cloudflare", "ruleId": "cloudflare.interstitial", "evidence": ['title "Just a moment..."'], "url": "https://shop.example/shop", "site": "shop.example"}
HOME = '<!doctype html><title>Home</title><a href="/shop">Checkout</a><button>Go</button><input id="q">'


@pytest_asyncio.fixture
async def wrapped(browser, tmp_path):
    made = []

    async def make(outcomes=(), **kw):
        wrap_kw = kw.pop("wrap", {})
        engine = GuardEngine(tmp_path, outcomes, **kw)
        ctx = await browser.new_context()
        await ctx.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<title>Shop</title>" if urlparse(route.request.url).path == "/shop" else HOME))
        page = await ctx.new_page()
        u = Unstuck(engine_path=engine.path, on_link=lambda l: None)
        made.append((u, ctx))
        return u.wrap(page, **wrap_kw), engine

    yield make
    for u, ctx in made:
        await u.close()
        await ctx.close()


async def test_goto_returns_past_a_resolved_rescue(wrapped):
    seen = []
    page, engine = await wrapped(outcomes=[{"status": "resolved", "check": CF, "waitedS": 3.2}], wrap={"on_rescue": seen.append, "remember": True, "max_rescues_per_hour": 3})
    await page.goto("https://shop.example/shop")
    ev = page.unstuck.last_rescue
    assert isinstance(ev, RescueEvent) and isinstance(ev.check, HumanCheck)
    assert ev.status == "resolved" and ev.check.vendor == "cloudflare" and ev.waited_s == 3.2 and ev.check.rule_id == "cloudflare.interstitial"
    assert seen == [ev]
    opened = engine.calls("guard.open")[0]
    assert opened["browserKey"] == str(id(page.context.browser)) and opened["remember"] is True and opened["maxRescuesPerHour"] == 3
    assert opened["rescue"] == ["challenge"] and opened["profile"] == "default"
    assert engine.calls("guard.before")[0] == {"guardId": "g1", "url": "https://shop.example/shop"}
    assert engine.calls("guard.after")[0] == {"guardId": "g1", "requestedUrl": "https://shop.example/shop"}
    assert engine.calls("engine.hello")[0]["protocolMinor"] == 1


async def test_failed_rescue_raises_with_status_and_detail(wrapped):
    page, _ = await wrapped(outcomes=[{"status": "timed_out", "check": CF, "waitedS": 600, "detail": "nobody came", "takeover": {"status": "timed_out", "sessionId": "s", "url": "u", "durationS": 600}}])
    with pytest.raises(UnstuckRescueError) as e:
        await page.goto("https://shop.example/shop")
    assert e.value.status == "timed_out" and e.value.detail == "nobody came" and e.value.check.site == "shop.example"
    assert e.value.event is page.unstuck.last_rescue and e.value.event.takeover.status == "timed_out"
    assert str(e.value) == "Unstuck could not get past a challenge on shop.example: timed_out (nobody came)"


async def test_on_rescue_fail_return_returns_normally(wrapped):
    page, _ = await wrapped(outcomes=[{"status": "rescue_limited", "check": CF, "waitedS": 0}], wrap={"on_rescue_fail": "return"})
    assert await page.goto("https://shop.example/shop") is not None
    assert page.unstuck.last_rescue.status == "rescue_limited"


async def test_no_check_no_error(wrapped):
    page, engine = await wrapped(outcomes=[])
    await page.goto("https://shop.example/")
    await page.reload()
    await page.fill("#q", "hi")
    await page.press("#q", "Enter")
    assert page.unstuck.last_rescue is None
    assert await page.unstuck.check() is None
    assert [c.get("mayNavigate") for c in engine.calls("guard.after")] == [None, None, False, True]


async def test_sync_page_is_refused():
    class SyncPage:
        def goto(self, url):
            return None

    with pytest.raises(TypeError) as e:
        Unstuck(engine_path="x").wrap(SyncPage())
    assert str(e.value) == "wrap() supports async Playwright pages (playwright.async_api); sync Playwright is not supported yet"


async def test_old_engine_is_refused_clearly(wrapped):
    page, _ = await wrapped(capabilities=None)
    with pytest.raises(UnstuckEngineError) as e:
        await page.goto("https://shop.example/")
    assert str(e.value) == "this engine (fake-guard) has no Unstuck Browser support: update the unstuck package, or unset UNSTUCK_ENGINE_PATH"


async def test_expect_navigation_checks_on_exit(wrapped):
    page, engine = await wrapped(outcomes=[None, {"status": "resolved", "check": CF, "waitedS": 1}])
    await page.goto("https://shop.example/")
    async with page.expect_navigation():
        await page.evaluate("location.href = '/shop'")
    assert page.unstuck.last_rescue.status == "resolved"
    assert len(engine.calls("guard.after")) == 2


# Review Focus 1
async def test_get_by_role_click_is_guarded(wrapped):
    page, engine = await wrapped(outcomes=[None, {"status": "resolved", "check": CF, "waitedS": 1}])
    await page.goto("https://shop.example/")
    await page.get_by_role("link", name="Checkout").click()
    assert engine.calls("guard.after")[-1]["mayNavigate"] is True and page.unstuck.last_rescue.status == "resolved"


async def test_chained_locators_are_guarded(wrapped):
    page, engine = await wrapped(outcomes=[None, None, None, None, {"status": "resolved", "check": CF, "waitedS": 1}])
    await page.goto("https://shop.example/")
    await page.locator("body").locator("a").filter(has_text="Checkout").first.click()
    await page.goto("https://shop.example/")
    await page.get_by_text("Go").nth(0).or_(page.get_by_role("button")).first.click()
    await page.locator("#q").and_(page.locator("input")).last.fill("x")
    assert len(engine.calls("guard.after")) == 5 and page.unstuck.last_rescue.status == "resolved"
    assert await page.locator("a").count() == 1  # everything else is the locator's own


async def test_page_guard_methods(wrapped):
    page, engine = await wrapped(outcomes=[None, {"status": "resolved", "check": {**CF, "kind": "ask", "ruleId": "ask_human"}, "waitedS": 1}])
    await page.goto("https://shop.example/")
    assert (await page.unstuck.ask_human("Log in")).check.kind == "ask"
    s = await page.unstuck.get_session("shop.example")
    assert isinstance(s, SiteSession) and s.cookie_header == "cf_clearance=ok" and s.user_agent == "UA/1"
    assert s.cookies == [StoredCookie(name="cf_clearance", value="ok", domain=".shop.example", path="/", expires=-1, http_only=True, secure=True, same_site="Lax")]
    await page.unstuck.remember_site("shop.example")
    await page.unstuck.forget_site("shop.example")
    await page.unstuck.forget_all()
    assert engine.calls("guard.askHuman") == [{"guardId": "g1", "reason": "Log in"}]
    assert engine.calls("guard.getSession") == [{"guardId": "g1", "domain": "shop.example"}]
    assert engine.calls("guard.forgetAll") == [{"guardId": "g1"}]


async def test_wrapping_twice_hooks_once(wrapped):
    page, engine = await wrapped(outcomes=[])
    goto = page.goto
    assert Unstuck(engine_path="x").wrap(page) is page and page.goto is goto


async def test_takeover_options_reach_guard_open(wrapped):
    page, engine = await wrapped(wrap={"rescue": ["challenge", "login"], "profile": "work", "timeout_s": 90, "allowed_sites": ["sso.example"], "alerts": False, "require_code": True})
    await page.goto("https://shop.example/")
    opened = engine.calls("guard.open")[0]
    assert opened["rescue"] == ["challenge", "login"] and opened["profile"] == "work" and opened["timeoutS"] == 90
    assert opened["allowedSites"] == ["sso.example"] and opened["alerts"] is False and opened["requireCode"] is True


async def test_page_create_and_close_for_the_paint_check(wrapped):
    page, engine = await wrapped(probe=True)
    await page.goto("https://shop.example/")
    replies = {e["method"]: [] for e in engine.entries()}
    for e in engine.entries():
        replies[e["method"]].append(e["params"])
    created, second_create = replies["<-page.create"]
    assert created["result"]["pageId"].startswith("page-")
    assert replies["<-cdp.send"][0]["result"]["result"]["value"] == 2
    closed, closed_again = replies["<-page.close"]
    assert closed["result"] == {} and "unknown page" in closed_again["error"]["message"]
    assert "unknown page" in second_create["error"]["message"]
    assert len(page.context.pages) == 1  # the probe tab is gone


async def test_guard_rescue_follows_popups_while_active(wrapped):
    page, engine = await wrapped(outcomes=[None], rescue_notes=True)
    await page.goto("https://shop.example/")
    assert page.unstuck.last_rescue is None
    reply = [e for e in engine.entries() if e["method"] == "<-cdp.send"][0]["params"]
    assert "unknown page" in reply["error"]["message"]


async def test_closing_the_page_closes_its_guard(wrapped):
    page, engine = await wrapped(outcomes=[])
    await page.goto("https://shop.example/")
    await page.close()
    for _ in range(50):
        if engine.calls("guard.close"):
            break
        await asyncio.sleep(0.05)
    assert engine.calls("guard.close") == [{"guardId": "g1"}]
