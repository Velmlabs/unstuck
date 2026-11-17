import importlib
import sys

import pytest

if sys.version_info < (3, 11):
    pytest.importorskip("browser_use")

from unstuck import HumanCheck, RescueEvent  # noqa: E402
from unstuck.browser_use import UNSTUCK_SYSTEM_MESSAGE, UnstuckTools  # noqa: E402

CHECK = HumanCheck(kind="challenge", rule_id="cloudflare.interstitial", evidence=[], url="https://shop.example/", site="shop.example", vendor="cloudflare")


class FakeGuard:
    def __init__(self, outcome):
        self.outcome = outcome
        self.asked = []

    async def check(self):
        return self.outcome

    async def ask_human(self, reason):
        self.asked.append(reason)
        return self.outcome


class FakePage:
    def __init__(self, url, outcome=None):
        self.url = url
        self.unstuck = FakeGuard(outcome)


class FakeUnstuck:
    def __init__(self):
        self.wrapped = []
        self.closed = False

    def wrap(self, page, **kw):
        self.wrapped.append((page, kw))
        return page

    async def close(self):
        self.closed = True


def tools_for(pages, **wrap_options):
    u = FakeUnstuck()
    connects = []

    async def connect():
        connects.append(1)
        return pages

    t = UnstuckTools("http://127.0.0.1:9222", unstuck=u, _connect=connect, **wrap_options)
    return t, u, connects


def call(tools, name, **args):
    fn = next(f for f in tools.functions if f.name == name).function
    return fn(**args)


def test_registers_two_actions():
    t = UnstuckTools("http://127.0.0.1:9222")
    assert [f.name for f in t.functions] == ["ask_human", "check_page"]


async def test_check_page_reports_a_solved_check():
    page = FakePage("https://shop.example/cart", RescueEvent(status="resolved", check=CHECK, waited_s=3))
    t, u, connects = tools_for([FakePage("https://other.example/"), page], remember=True)
    assert await call(t, "check_page", url="https://shop.example/") == "A person solved the check on shop.example. Look at the page again and carry on."
    assert u.wrapped == [(page, {"on_rescue_fail": "return", "remember": True})]
    await call(t, "check_page", url="https://shop.example/cart")
    assert connects == [1]  # connected once


async def test_check_page_with_nothing_found():
    t, _, _ = tools_for([FakePage("https://shop.example/")])
    assert await call(t, "check_page", url="https://shop.example/") == "No human check on this page."


async def test_still_blocked_tells_the_model_to_stop():
    t, _, _ = tools_for([FakePage("https://shop.example/", RescueEvent(status="timed_out", check=CHECK, waited_s=600, detail="nobody came"))])
    assert await call(t, "check_page", url="https://shop.example/") == "Still blocked (timed_out: nobody came). Stop, or try another way; do not retry the check yourself."
    t2, _, _ = tools_for([FakePage("https://shop.example/", RescueEvent(status="rescue_limited", check=CHECK, waited_s=0))])
    assert await call(t2, "ask_human", reason="log in", url="https://shop.example/") == "Still blocked (rescue_limited). Stop, or try another way; do not retry the check yourself."


async def test_ask_human_resolved():
    page = FakePage("https://shop.example/login", RescueEvent(status="resolved", check=CHECK, waited_s=20))
    t, _, _ = tools_for([page])
    # The model may name a deeper URL than the tab's: the tab still matches.
    assert await call(t, "ask_human", reason="Log in", url="https://shop.example/login?next=/") == "The person finished (resolved). Look at the page again before continuing."
    assert page.unstuck.asked == ["Log in"]


async def test_unknown_url():
    t, _, _ = tools_for([FakePage(""), FakePage("https://shop.example/")])
    assert await call(t, "check_page", url="https://nowhere.example/") == "No open tab is on https://nowhere.example/; check the URL and ask again."


def test_system_message_names_both_actions_and_forbids_solving():
    assert "check_page" in UNSTUCK_SYSTEM_MESSAGE and "ask_human" in UNSTUCK_SYSTEM_MESSAGE
    assert "Never try to solve a CAPTCHA" in UNSTUCK_SYSTEM_MESSAGE and "CAPTCHA-solving service" in UNSTUCK_SYSTEM_MESSAGE


async def test_aclose_closes_what_it_opened():
    t, u, _ = tools_for([FakePage("https://shop.example/")])
    await t.aclose()  # nothing connected yet
    await call(t, "check_page", url="https://shop.example/")
    await t.aclose()
    assert u.closed is False  # a caller's Unstuck is the caller's to close
    own = UnstuckTools("http://127.0.0.1:9222")
    await own.aclose()


async def test_connects_over_cdp_to_a_real_browser(pw):
    browser = await pw.chromium.launch(args=["--remote-debugging-port=9333"])
    page = await browser.new_page()
    await page.set_content("<title>x</title>")
    t = UnstuckTools("http://127.0.0.1:9333", unstuck=FakeUnstuck())
    assert await call(t, "check_page", url="https://nowhere.example/") == "No open tab is on https://nowhere.example/; check the URL and ask again."
    await t.aclose()
    await browser.close()


def test_import_without_browser_use_says_how_to_install(monkeypatch):
    monkeypatch.setitem(sys.modules, "browser_use", None)
    monkeypatch.delitem(sys.modules, "unstuck.browser_use", raising=False)
    with pytest.raises(ImportError) as e:
        importlib.import_module("unstuck.browser_use")
    assert str(e.value) == "unstuck.browser_use needs browser-use 1.0.6: pip install 'unstuck[browser-use]'"
