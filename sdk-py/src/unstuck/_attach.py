"""A CDP session on the developer's Playwright page (mirrors sdk-ts/src/attach.ts)."""

from __future__ import annotations

import itertools
import time
from typing import Any, Callable

from ._errors import PageClosedError

_counter = itertools.count()


def _new_page_id() -> str:
    return f"page-{int(time.time() * 1000):x}-{next(_counter):x}"


class AttachedPage:
    def __init__(self, page: Any, session: Any) -> None:
        self.page_id = _new_page_id()
        self._page = page
        self._session = session
        self._close_cbs: list[Callable[[str], None]] = []
        self._closed: str | None = None
        self._on_page_close = lambda *_: self._fire("page closed")
        self._on_crash = lambda *_: self._fire("page crashed")
        page.on("close", self._on_page_close)
        page.on("crash", self._on_crash)

    def _fire(self, reason: str) -> None:
        if self._closed is not None:
            return
        self._closed = reason
        for cb in list(self._close_cbs):
            cb(reason)

    def url(self) -> str:
        return self._page.url

    async def send(self, method: str, params: Any = None) -> Any:
        return await self._session.send(method, params or {})

    def subscribe(self, event: str, cb: Callable[[Any], None]) -> None:
        # Playwright tags handlers with an attribute, which built-ins (e.g. list.append) cannot carry.
        self._session.on(event, lambda params: cb(params))

    def on_close(self, cb: Callable[[str], None]) -> None:
        if self._closed is not None:
            cb(self._closed)
        else:
            self._close_cbs.append(cb)

    async def detach(self) -> None:
        for event, cb in (("close", self._on_page_close), ("crash", self._on_crash)):
            try:
                self._page.remove_listener(event, cb)
            except Exception:  # noqa: BLE001 - listener may already be gone
                pass
        try:
            await self._session.detach()
        except Exception:  # noqa: BLE001 - page or session already closed
            pass


async def attach_page(page: Any) -> AttachedPage:
    """Opens a CDP session on a Playwright (async) Page."""
    context = getattr(page, "context", None)
    if context is None or not hasattr(context, "new_cdp_session") or not callable(getattr(page, "is_closed", None)):
        raise TypeError("Unsupported page object: pass a Playwright Page")
    if page.is_closed():
        raise PageClosedError()
    try:
        session = await context.new_cdp_session(page)
    except Exception:
        if page.is_closed():
            raise PageClosedError() from None
        raise
    return AttachedPage(page, session)
