"""The Unstuck client (mirrors sdk-ts/src/unstuck.ts)."""

from __future__ import annotations

import asyncio
import sys
from typing import Any, Callable
from urllib.parse import urlparse

from ._attach import AttachedPage, attach_page
from ._engine import EngineProcess, resolve_engine_path, spawn_engine
from ._errors import PageClosedError, UnstuckEngineError
from ._rpc import RpcCallError
from ._types import TakeoverLink, TakeoverResult

SHUTDOWN_GRACE_S = 2.0
_PAGE_CLOSED = TakeoverResult(status="failed", session_id="", url="", duration_s=0, detail="page_closed")


def _default_on_link(link: TakeoverLink) -> None:
    print(f"Unstuck: a human is needed ({link.reason}) → {link.url}", file=sys.stderr, flush=True)


def _site_of(url: str) -> str | None:
    try:
        return urlparse(url).hostname or None
    except ValueError:
        return None


class Unstuck:
    """Pauses your agent until a human finishes a takeover. Awaiting `takeover()` IS the pause."""

    def __init__(
        self,
        *,
        engine_path: str | None = None,
        host: str | None = None,
        port: int | None = None,
        timeout_s: int | None = None,
        on_link: Callable[[TakeoverLink], None] | None = None,
    ) -> None:
        self._engine_path = engine_path
        self._host = host
        self._port = port
        self._timeout_s = timeout_s
        self._on_link = on_link or _default_on_link
        self._engine: asyncio.Task[EngineProcess] | None = None
        self._pages: dict[str, AttachedPage] = {}

    async def __aenter__(self) -> "Unstuck":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def takeover(self, page: Any, *, reason: str, timeout_s: int | None = None) -> TakeoverResult:
        """Returns the outcome; raises only UnstuckEngineError when the engine can't run."""
        try:
            attached = await attach_page(page)
        except PageClosedError:
            return _PAGE_CLOSED
        loop = asyncio.get_running_loop()
        closed_early = loop.create_future()
        notify_close: list[Callable[[str], None]] = []

        def on_close(reason_: str) -> None:
            if notify_close:
                notify_close[0](reason_)
            elif not closed_early.done():
                closed_early.set_result(reason_)

        attached.on_close(on_close)
        try:
            starting = self._ensure_engine()
            done, _ = await asyncio.wait({starting, closed_early}, return_when=asyncio.FIRST_COMPLETED)
            if closed_early in done:
                return _PAGE_CLOSED
            engine = starting.result()
            self._pages[attached.page_id] = attached
            notify_close.append(lambda r: engine.peer.notify("cdp.closed", {"pageId": attached.page_id, "reason": r}))
            params = {"pageId": attached.page_id, "reason": reason, "timeoutS": timeout_s or self._timeout_s, "site": _site_of(attached.url())}
            try:
                return TakeoverResult.from_wire(await engine.peer.request("takeover", params))
            except RpcCallError as e:
                if e.code == "closed":
                    raise UnstuckEngineError(f"engine exited with code {await engine.wait()}") from None
                raise
        finally:
            self._pages.pop(attached.page_id, None)
            if not closed_early.done():
                closed_early.cancel()
            await attached.detach()

    async def close(self) -> None:
        """Stops the engine, cancelling any running takeover."""
        starting, self._engine = self._engine, None
        if starting is None:
            return
        try:
            engine = await starting
        except UnstuckEngineError:
            return
        shutdown = asyncio.ensure_future(engine.peer.request("shutdown", {}))
        try:
            await asyncio.wait_for(engine.wait(), timeout=SHUTDOWN_GRACE_S)
        except asyncio.TimeoutError:
            engine.kill()
            await engine.wait()
        await asyncio.gather(shutdown, return_exceptions=True)

    def _ensure_engine(self) -> asyncio.Task[EngineProcess]:
        """Reuses a starting or running engine; respawns after a failed start or an exit."""
        task = self._engine
        reusable = task is not None and (not task.done() or (task.exception() is None and task.result().returncode is None))
        if not reusable:
            task = self._engine = asyncio.ensure_future(self._start_engine())
        assert task is not None
        return task

    async def _start_engine(self) -> EngineProcess:
        engine = await spawn_engine(resolve_engine_path(self._engine_path), host=self._host, port=self._port)
        peer = engine.peer

        def page_for(params: dict[str, Any]) -> AttachedPage:
            page = self._pages.get(params["pageId"])
            if page is None:
                raise RuntimeError(f"unknown page {params['pageId']}")
            return page

        async def cdp_send(params: dict[str, Any]) -> Any:
            return await page_for(params).send(params["method"], params.get("params"))

        def cdp_subscribe(params: dict[str, Any]) -> dict[str, Any]:
            page = page_for(params)
            for event in params["events"]:
                page.subscribe(event, lambda p, e=event: peer.notify("cdp.event", {"pageId": params["pageId"], "method": e, "params": p}))
            return {}

        peer.handle("cdp.send", cdp_send)
        peer.handle("cdp.subscribe", cdp_subscribe)
        peer.on_notification("takeover.link", lambda p: self._on_link(TakeoverLink.from_wire(p)))
        return engine
