"""The Unstuck client (mirrors sdk-ts/src/unstuck.ts)."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any, Awaitable, Callable, Literal, Sequence
from urllib.parse import urlparse

from ._attach import AttachedPage, attach_page
from ._engine import EngineProcess, resolve_engine_path, spawn_engine
from ._errors import PageClosedError, UnstuckConfigError, UnstuckEngineError
from ._rpc import RpcCallError
from ._types import AskResult, CheckKind, RescueEvent, TakeoverLink, TakeoverResult
from ._wrap import wrap_page

SHUTDOWN_GRACE_S = 2.0
_PAGE_CLOSED = TakeoverResult(status="failed", session_id="", url="", duration_s=0, detail="page_closed")


def _default_on_link(link: TakeoverLink) -> None:
    # Never prints a 6-digit code: require_code needs its own on_link, so the code travels apart from the link.
    print(f"Unstuck: a human is needed ({link.reason}) → {link.url}", file=sys.stderr, flush=True)


ENGINE_TOO_OLD_FOR_ASK = "this engine can't ask questions (needs @velmlabs/unstuck-engine 0.4.0 or later)"


def _check_ask(question: Any, choices: Any, allow_text: Any, private: Any, details: Any, timeout_s: Any) -> str | None:
    """Why this can't be asked, or None (the engine's checkAsk messages, word for word)."""
    if not isinstance(question, str) or not question.strip() or len(question) > 300:
        return "question must be 1-300 characters"
    if choices is not None and (
        not isinstance(choices, (list, tuple))
        or not 2 <= len(choices) <= 6
        or not all(isinstance(c, str) and c.strip() != "" and len(c) <= 80 for c in choices)
    ):
        return "choices must be 2-6 labels of at most 80 characters"
    if allow_text is False and choices is None:
        return "a question needs choices or allowText"
    if details is not None and (not isinstance(details, str) or len(details) > 1000):
        return "details must be at most 1000 characters"
    if timeout_s is not None and (isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)) or not 10 <= timeout_s <= 3600):
        return "timeoutS must be 10-3600"
    if allow_text is not None and not isinstance(allow_text, bool):
        return "allowText must be true or false"
    if not isinstance(private, bool):
        return "private must be true or false"
    return None


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _check_relay_url(relay: str | None) -> None:
    """wss:// anywhere, ws:// only to this machine (as the TypeScript SDK checks its ``relay`` option)."""
    if not relay:
        return  # unset (an empty string is unset too)
    try:
        url = urlparse(relay)
        host = url.hostname
    except ValueError:
        url, host = None, None
    if url is not None and (url.scheme == "wss" or (url.scheme == "ws" and host in _LOCAL_HOSTS)):
        return
    raise UnstuckConfigError("relay must be a wss:// URL (ws:// only to localhost, 127.0.0.1 or [::1])")


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
        relay: str | None = None,
        agent_key: str | None = None,
        require_code: bool | None = None,
        agent_name: str | None = None,
        approval_timeout_s: int | None = None,
    ) -> None:
        """``agent_name`` names this agent in alerts (the engine reads UNSTUCK_AGENT_NAME; empty means the key's name);
        ``approval_timeout_s`` is how long a person has to approve a sign-in (default 300). ``relay``/``agent_key`` use a relay instead of the local server (or set UNSTUCK_RELAY_URL /
        UNSTUCK_AGENT_KEY; with only UNSTUCK_API_KEY set, Unstuck Cloud is used). ``require_code`` asks the
        human for a 6-digit code delivered with the link. Raises UnstuckConfigError for a ``relay`` that is not
        wss:// (ws:// only to localhost)."""
        _check_relay_url(relay)
        self._engine_path = engine_path
        self._host = host
        self._port = port
        self._timeout_s = timeout_s
        self._on_link = on_link or _default_on_link
        self._relay = relay
        self._agent_key = agent_key
        self._require_code = require_code
        self._agent_name = agent_name
        self._approval_timeout_s = approval_timeout_s
        # Questions waiting for their link by link id: the engine echoes it in ask.link, so concurrent asks never swap links.
        self._ask_links: dict[str, Callable[[TakeoverLink], None]] = {}
        self._next_ask_link = 0
        self._engine: asyncio.Task[EngineProcess] | None = None
        self._pages: dict[str, AttachedPage] = {}
        # Probe tabs the engine opened (page.create), and popup followers of active guard rescues.
        self._probes: dict[str, Any] = {}
        self._rescue_popups: dict[str, Callable[[], Awaitable[None]]] = {}
        self._tasks: set[asyncio.Future[Any]] = set()

    async def __aenter__(self) -> "Unstuck":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def takeover(
        self,
        page: Any,
        *,
        reason: str,
        timeout_s: int | None = None,
        require_code: bool | None = None,
        allowed_sites: list[str] | None = None,
        alerts: bool | Literal["required"] | None = None,
    ) -> TakeoverResult:
        """Returns the outcome; raises only UnstuckEngineError when the engine can't run (and ValueError for misuse:
        UnstuckConfigError, a ValueError, for inconsistent options).

        The human can only navigate the page within its own site (example.com and its subdomains); list any other
        sites the flow needs in ``allowed_sites``, e.g. ``["accounts.google.com"]``.

        With Unstuck Cloud (``UNSTUCK_API_KEY``) the link is also sent to your paired phones; ``alerts=False`` skips that.
        ``alerts="required"`` ends the takeover at once with status ``failed``, detail ``alert_failed``, if Unstuck
        Cloud can't accept the link for at least one paired phone (alerts not allowed for the key, no paired phone, every seal
        failed, or Cloud refused it); without Unstuck Cloud it raises UnstuckConfigError.
        """
        wants_code = self._require_code if require_code is None else require_code
        if wants_code is None:
            wants_code = os.environ.get("UNSTUCK_REQUIRE_CODE") == "1"  # the engine inherits this environment
        if wants_code and self._on_link is _default_on_link:
            raise ValueError(
                "require_code needs an on_link handler that sends the 6-digit code by a different channel than the link "
                "(printed together, the code protects nothing)"
            )
        try:
            attached = await attach_page(page)
        except PageClosedError:
            return _PAGE_CLOSED
        loop = asyncio.get_running_loop()
        closed_early = loop.create_future()
        notify_close: list[Callable[[str], None]] = []
        stop_following: list[Callable[[], Awaitable[None]]] = []
        answered: list[bool] = []

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

            stop_following.append(self._follow(engine, attached, page))
            params = {"pageId": attached.page_id, "reason": reason, "timeoutS": timeout_s or self._timeout_s, "site": _site_of(attached.url())}
            code = self._require_code if require_code is None else require_code
            if code is not None:
                params["requireCode"] = code
            if allowed_sites:
                params["allowedSites"] = list(allowed_sites)
            if alerts is False or alerts == "required":
                params["alerts"] = alerts
            try:
                result = TakeoverResult.from_wire(await engine.peer.request("takeover", params))
                answered.append(True)
                return result
            except RpcCallError as e:
                if e.code == "closed":
                    raise UnstuckEngineError(f"engine exited with code {await engine.wait()}") from None
                if e.code == "config_error":  # the engine refused the options, e.g. alerts="required" without Unstuck Cloud
                    raise UnstuckConfigError(e.message) from None
                raise
        finally:
            if notify_close and not answered:
                # Cancelled by the caller (e.g. asyncio.wait_for): end the engine session so the link stops working.
                notify_close[0]("cancelled by caller")
            for stop in stop_following:
                await stop()
            self._pages.pop(attached.page_id, None)
            if not closed_early.done():
                closed_early.cancel()
            await attached.detach()

    async def ask(
        self,
        question: str,
        *,
        choices: list[str] | None = None,
        allow_text: bool | None = None,
        private: bool = True,
        details: str | None = None,
        timeout_s: int | None = None,
        on_link: Callable[[TakeoverLink], None] | None = None,
    ) -> AskResult:
        """Asks the person a question (no browser page); awaiting this IS the pause. The link goes to ``on_link`` (default:
        this client's ``on_link``, else printed to stderr) and, with Unstuck Cloud, to paired phones. Returns the outcome
        (``status`` answered, timed_out, cancelled or failed). Raises UnstuckConfigError for a question out of range (nothing
        is started) and UnstuckEngineError when the engine can't run or is too old to ask."""
        problem = _check_ask(question, choices, allow_text, private, details, timeout_s)
        if problem:
            raise UnstuckConfigError(problem)
        params: dict[str, Any] = {"question": question, "private": private}
        for key, value in (("choices", choices), ("allowText", allow_text), ("details", details), ("timeoutS", timeout_s)):
            if value is not None:
                params[key] = list(value) if key == "choices" else value
        engine = await self._ensure_engine()
        if "ask" not in engine.capabilities:
            raise UnstuckEngineError(ENGINE_TOO_OLD_FOR_ASK)
        link_id = f"ask-{self._next_ask_link}"
        self._next_ask_link += 1
        self._ask_links[link_id] = on_link or self._on_link
        try:
            return AskResult.from_wire(await engine.peer.request("ask", {**params, "linkId": link_id}))
        except RpcCallError as e:
            if e.code == "closed":
                raise UnstuckEngineError(f"engine exited with code {await engine.wait()}") from None
            if e.code in ("bad_params", "config_error"):
                raise UnstuckConfigError(e.message) from None
            raise
        finally:
            self._ask_links.pop(link_id, None)

    def wrap(
        self,
        page: Any,
        *,
        rescue: Sequence[CheckKind] = ("challenge", "approval"),
        remember: bool = False,
        profile: str = "default",
        max_rescues_per_hour: int = 10,
        on_rescue_fail: Literal["throw", "return"] = "throw",
        on_rescue: Callable[[RescueEvent], None] | None = None,
        timeout_s: int | None = None,
        allowed_sites: list[str] | None = None,
        alerts: bool | Literal["required"] | None = None,
        require_code: bool | None = None,
        approval_timeout_s: int | None = None,
    ) -> Any:
        """Guards an async Playwright page: navigations and clicks that land on a human check (a CAPTCHA, Cloudflare's
        "verify you are human") bring a person in and return once they're past it. Returns the same page, with
        ``page.unstuck``. A rescue that doesn't end ``resolved`` raises UnstuckRescueError (``on_rescue_fail="return"``
        returns normally instead; read ``page.unstuck.last_rescue``)."""
        return wrap_page(
            self, page, rescue=rescue, remember=remember, profile=profile, max_rescues_per_hour=max_rescues_per_hour,
            on_rescue_fail=on_rescue_fail, on_rescue=on_rescue, timeout_s=timeout_s, allowed_sites=allowed_sites,
            alerts=alerts, require_code=require_code,
            approval_timeout_s=self._approval_timeout_s if approval_timeout_s is None else approval_timeout_s,
        )

    def _background(self, aw: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(aw)
        self._tasks.add(task)
        task.add_done_callback(lambda t: (self._tasks.discard(t), t.cancelled() or t.exception()))

    def _follow(self, engine: EngineProcess, attached: AttachedPage, page: Any) -> Callable[[], Awaitable[None]]:
        """Follows the popups `page` opens (a CAPTCHA provider's window) for the engine; returns how to stop."""
        popups: list[AttachedPage] = []
        tasks: set[asyncio.Future[None]] = set()

        async def follow(popup_page: Any) -> None:
            try:
                popup = await attach_page(popup_page)
            except Exception:  # noqa: BLE001 - a popup that closes before we attach is not followed
                return
            popups.append(popup)
            self._pages[popup.page_id] = popup
            popup.on_close(lambda r: engine.peer.notify("cdp.closed", {"pageId": popup.page_id, "reason": r}))
            engine.peer.notify("page.popup", {"pageId": attached.page_id, "popupPageId": popup.page_id})

        def on_popup(popup_page: Any) -> None:
            tasks.add(asyncio.ensure_future(follow(popup_page)))

        page.on("popup", on_popup)

        async def stop() -> None:
            page.remove_listener("popup", on_popup)
            await asyncio.gather(*tasks, return_exceptions=True)
            for popup in popups:
                self._pages.pop(popup.page_id, None)
                await popup.detach()

        return stop

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
        engine = await spawn_engine(
            resolve_engine_path(self._engine_path), host=self._host, port=self._port, relay=self._relay, agent_key=self._agent_key,
            agent_name=self._agent_name,
        )
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

        async def page_create(params: dict[str, Any]) -> dict[str, Any]:
            opener = page_for(params)
            tab = await opener._page.context.new_page()
            attached = await attach_page(tab)
            self._pages[attached.page_id] = attached
            self._probes[attached.page_id] = tab
            return {"pageId": attached.page_id}

        async def page_close(params: dict[str, Any]) -> dict[str, Any]:
            tab = self._probes.pop(params["pageId"], None)
            if tab is None:
                raise RuntimeError(f"unknown page {params['pageId']}")
            attached = self._pages.pop(params["pageId"])
            await attached.detach()
            await tab.close()
            return {}

        def guard_rescue(params: dict[str, Any]) -> None:
            key = params["guardId"]
            if params["active"]:
                attached = self._pages.get(params["pageId"])
                if attached is not None and key not in self._rescue_popups:
                    self._rescue_popups[key] = self._follow(engine, attached, attached._page)
            elif key in self._rescue_popups:
                self._background(self._rescue_popups.pop(key)())

        peer.handle("cdp.send", cdp_send)
        peer.handle("cdp.subscribe", cdp_subscribe)
        peer.handle("page.create", page_create)
        peer.handle("page.close", page_close)
        peer.on_notification("guard.rescue", guard_rescue)
        def ask_link(p: dict[str, Any]) -> None:
            on_link = self._ask_links.get(p.get("linkId") or "")  # a link for no known ask is ignored
            if on_link is not None:
                on_link(TakeoverLink.from_wire(p))

        peer.on_notification("ask.link", ask_link)
        peer.on_notification("takeover.link", lambda p: self._on_link(TakeoverLink.from_wire(p)))
        return engine
