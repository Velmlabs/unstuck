"""browser-use 1.0.6 integration: tools the model calls when a page needs a person.

browser-use 1.0 has no step hooks, so the guard runs when the model calls ``check_page`` (the system message tells it to
after each navigation or submit) or ``ask_human``::

    tools = UnstuckTools(cdp_url)
    agent = Agent(task, llm, browser=Browser(cdp_url=cdp_url), tools=tools, extend_system_message=UNSTUCK_SYSTEM_MESSAGE)
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

try:
    from browser_use import Tools
except ImportError as e:  # pragma: no cover - exercised by a test that hides browser_use
    raise ImportError("unstuck.browser_use needs browser-use 1.0.6: pip install 'unstuck[browser-use]'") from e

from ._client import Unstuck
from ._types import RescueEvent

UNSTUCK_SYSTEM_MESSAGE = (
    "After you open a page or submit a form, call check_page with the current URL. If it says a person solved a check, "
    "carry on. Never try to solve a CAPTCHA or a 'verify you are human' check yourself and never use a CAPTCHA-solving "
    "service: a person does it through check_page. For a login, a 2FA code or anything only a person can do, call "
    "ask_human with the reason and the URL."
)

__all__ = ["UNSTUCK_SYSTEM_MESSAGE", "UnstuckTools"]


def _still_blocked(event: RescueEvent) -> str:
    detail = f": {event.detail}" if event.detail else ""
    return f"Still blocked ({event.status}{detail}). Stop, or try another way; do not retry the check yourself."


def _matches(tab_url: str, url: str) -> bool:
    return bool(tab_url) and (tab_url.startswith(url) or url.startswith(tab_url))


class UnstuckTools(Tools):
    """browser-use Tools with ``ask_human`` and ``check_page``, on the same Chrome the agent drives (``cdp_url``)."""

    def __init__(self, cdp_url: str, *, unstuck: Unstuck | None = None, _connect: Callable[[], Awaitable[list[Any]]] | None = None, **wrap_options: Any) -> None:
        super().__init__()
        self._cdp_url = cdp_url
        self._own_unstuck = unstuck is None
        self._unstuck = unstuck or Unstuck()
        self._wrap_options = wrap_options
        self._connect_seam = _connect
        self._playwright: Any = None
        self._browser: Any = None

        async def ask_human(reason: str, url: str) -> str:
            page = await self._page(url)
            if page is None:
                return f"No open tab is on {url}; check the URL and ask again."
            event = await page.unstuck.ask_human(reason)
            if event.status == "resolved":
                return "The person finished (resolved). Look at the page again before continuing."
            return _still_blocked(event)

        async def check_page(url: str) -> str:
            page = await self._page(url)
            if page is None:
                return f"No open tab is on {url}; check the URL and ask again."
            event = await page.unstuck.check()
            if event is None:
                return "No human check on this page."
            if event.status == "resolved":
                return f"A person solved the check on {event.check.site}. Look at the page again and carry on."
            return _still_blocked(event)

        async def ask_question(question: str, choices: list[str] | None = None) -> str:
            result = await self._unstuck.ask(question, **({"choices": choices} if choices else {}))
            a = result.answer
            if result.status == "answered" and a is not None and (a.label or a.text):
                return a.label or a.text or ""
            detail = f": {result.detail}" if result.detail else ""
            return f"No answer ({result.status}{detail})"

        self.action("Bring in a person for something only they can do (a login, a 2FA code). Give the reason and the tab's URL.")(ask_human)
        self.action("Ask the person a question (optionally with 2-6 short choices) and get their answer.")(ask_question)
        self.action("After opening a page or submitting a form: checks the tab at this URL for a CAPTCHA or human check, and has a person solve it.")(check_page)

    async def _pages(self) -> list[Any]:
        if self._connect_seam is not None:
            if self._browser is None:
                self._browser = await self._connect_seam()
            return list(self._browser)
        if self._browser is None:
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.connect_over_cdp(self._cdp_url)
        return [p for ctx in self._browser.contexts for p in ctx.pages]

    async def _page(self, url: str) -> Any:
        tabs = [p for p in await self._pages() if _matches(p.url, url)]
        if not tabs:
            return None
        return self._unstuck.wrap(tabs[-1], on_rescue_fail="return", **self._wrap_options)

    async def aclose(self) -> None:
        """Disconnects from the browser (it keeps running) and stops the engine this object started."""
        if self._playwright is not None:
            await self._browser.close()
            await self._playwright.stop()
        self._browser = self._playwright = None
        if self._own_unstuck:
            await self._unstuck.close()
