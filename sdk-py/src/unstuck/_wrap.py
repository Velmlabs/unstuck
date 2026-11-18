"""``Unstuck.wrap(page)``: an async Playwright page whose navigations and clicks are guarded. Detection and rescue run in
the engine (``guard.*`` RPC methods); this module hooks the page and turns outcomes into events and errors."""

from __future__ import annotations

import asyncio
import inspect
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal, Sequence

from ._attach import AttachedPage, attach_page
from ._errors import UnstuckConfigError, UnstuckEngineError, UnstuckRescueError
from ._rpc import RpcCallError
from ._types import CheckKind, RescueEvent, SiteSession

if TYPE_CHECKING:
    from ._client import Unstuck
    from ._engine import EngineProcess

SYNC_PAGE = "wrap() supports async Playwright pages (playwright.async_api); sync Playwright is not supported yet"

# name -> (navigates, may_navigate, url from args)
_NAVIGATING = ("goto", "reload", "go_back", "go_forward", "wait_for_url", "wait_for_load_state")
_ACTING = {"click": True, "press": True, "fill": False}
LOCATOR_FACTORIES = ("locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder", "get_by_alt_text", "get_by_title", "get_by_test_id")
LOCATOR_CHAIN = (*LOCATOR_FACTORIES, "filter", "first", "last", "nth", "and_", "or_")
LOCATOR_ACTIONS = ("click", "dblclick", "tap", "fill", "press", "press_sequentially", "check", "uncheck", "select_option")

Run = Callable[..., Awaitable[Any]]


_GUARDED_CLASSES: dict[type, type] = {}


def _guarded_class(base: type) -> type:
    """A subclass of the library's own Locator class: `isinstance(x, Locator)` (and so `expect(locator)`) still holds.
    Actions run guarded; chained locators (methods and the `first`/`last` properties) are guarded too."""
    cls = _GUARDED_CLASSES.get(base)
    if cls is not None:
        return cls
    ns: dict[str, Any] = {}
    for name in LOCATOR_ACTIONS:
        original = inspect.getattr_static(base, name, None)
        if original is None:
            continue

        def act(self: Any, *args: Any, __original: Any = original, **kwargs: Any) -> Any:
            return self._unstuck_run(lambda: __original(self, *args, **kwargs), navigates=False, may_navigate=True)

        ns[name] = act
    for name in LOCATOR_CHAIN:
        original = inspect.getattr_static(base, name, None)
        if isinstance(original, property):
            ns[name] = property(lambda self, __p=original: _guard_locator(__p.fget(self), self._unstuck_run))
        elif original is not None:

            def chain(self: Any, *args: Any, __original: Any = original, **kwargs: Any) -> Any:
                return _guard_locator(__original(self, *args, **kwargs), self._unstuck_run)

            ns[name] = chain
    cls = type(f"Guarded{base.__name__}", (base,), ns)
    _GUARDED_CLASSES[base] = cls
    return cls


def _guard_locator(locator: Any, run: Run) -> Any:
    """Guards a locator in place (same object, a guarded subclass of its class)."""
    if locator is None or isinstance(locator, tuple(_GUARDED_CLASSES.values())):
        return locator
    locator._unstuck_run = run
    locator.__class__ = _guarded_class(type(locator))
    return locator


class _GuardedNavigation:
    """``expect_navigation()``: the guard checks the page once the block (and its navigation) is over."""

    def __init__(self, guard: "PageGuard", cm: Any) -> None:
        self._guard = guard
        self._cm = cm

    async def __aenter__(self) -> Any:
        await self._guard._before(None)
        return await self._cm.__aenter__()

    async def __aexit__(self, *exc: Any) -> Any:
        out = await self._cm.__aexit__(*exc)
        if exc[0] is None:
            await self._guard._after({})
        return out


class PageGuard:
    """``page.unstuck``: the guard of a wrapped page."""

    def __init__(self, client: "Unstuck", page: Any, opts: dict[str, Any], on_rescue: Callable[[RescueEvent], None] | None, on_rescue_fail: str) -> None:
        self._client = client
        self._page = page
        self._opts = opts
        self._on_rescue = on_rescue
        self._on_rescue_fail = on_rescue_fail
        self._guard_id: str | None = None
        self._engine: "EngineProcess | None" = None
        self._opening: asyncio.Task[str] | None = None
        self.last_rescue: RescueEvent | None = None

    async def _open(self) -> str:
        engine = await self._client._ensure_engine()
        if "guard" not in engine.capabilities:
            raise UnstuckEngineError(
                f"this engine ({engine.engine_version}) has no Unstuck Browser support: update the unstuck package, or unset UNSTUCK_ENGINE_PATH"
            )
        attached = await attach_page(self._page)
        self._client._pages[attached.page_id] = attached
        context = self._page.context
        params = {"pageId": attached.page_id, "browserKey": str(id(context.browser or context)), **self._opts}
        try:
            guard_id = (await engine.peer.request("guard.open", params))["guardId"]
        except BaseException:
            self._client._pages.pop(attached.page_id, None)
            await attached.detach()
            raise
        self._engine = engine
        attached.on_close(lambda reason: self._closed(engine, attached, reason))
        return guard_id

    def _closed(self, engine: "EngineProcess", attached: AttachedPage, reason: str) -> None:
        engine.peer.notify("cdp.closed", {"pageId": attached.page_id, "reason": reason})
        self._client._pages.pop(attached.page_id, None)
        guard_id, self._guard_id = self._guard_id, None
        if guard_id is not None:
            self._client._background(engine.peer.request("guard.close", {"guardId": guard_id}))

    async def _id(self) -> str:
        if self._guard_id is not None:
            return self._guard_id
        # A failed or cancelled open is tried again; a caller giving up (wait_for) never cancels the shared open.
        if self._opening is None or (self._opening.done() and (self._opening.cancelled() or self._opening.exception() is not None)):
            self._opening = asyncio.ensure_future(self._open())
        self._guard_id = await asyncio.shield(self._opening)
        return self._guard_id

    async def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        guard_id = await self._id()
        assert self._engine is not None
        try:
            return await self._engine.peer.request(method, {"guardId": guard_id, **(params or {})})
        except RpcCallError as e:
            if e.code == "closed":
                raise UnstuckEngineError(f"engine exited with code {await self._engine.wait()}") from None
            if e.code == "config_error":
                raise UnstuckConfigError(e.message) from None
            raise

    def _event(self, raw: Any) -> RescueEvent | None:
        if raw is None:
            return None
        event = RescueEvent.from_wire(raw)
        self.last_rescue = event
        if self._on_rescue is not None:
            self._on_rescue(event)
        return event

    def _settle(self, event: RescueEvent | None) -> None:
        if event is not None and event.status != "resolved" and self._on_rescue_fail != "return":
            raise UnstuckRescueError(event)

    async def _before(self, url: str | None) -> None:
        self._settle(self._event(await self._call("guard.before", {"url": url} if url else {})))

    async def _after(self, params: dict[str, Any]) -> None:
        self._settle(self._event(await self._call("guard.after", params)))

    async def run(self, call: Callable[[], Awaitable[Any]], *, url: str | None = None, navigates: bool, may_navigate: bool = False) -> Any:
        await self._before(url)
        out = await call()
        if navigates:
            await self._after({"requestedUrl": url} if url else {})
        else:
            await self._after({"mayNavigate": may_navigate})
        return out

    async def check(self) -> RescueEvent | None:
        """Looks at the page now and rescues a check it finds. Never raises for a failed rescue: read the status."""
        return self._event(await self._call("guard.check"))

    async def ask_human(self, reason: str) -> RescueEvent:
        """Brings a person in for something only they can do (a login, a code); counts toward the hourly limit."""
        event = self._event(await self._call("guard.askHuman", {"reason": reason}))
        assert event is not None
        return event

    async def get_session(self, domain: str | None = None) -> SiteSession:
        return SiteSession.from_wire(await self._call("guard.getSession", {"domain": domain} if domain else {}))

    async def remember_site(self, domain: str) -> None:
        await self._call("guard.rememberSite", {"domain": domain})

    async def forget_site(self, domain: str) -> None:
        await self._call("guard.forgetSite", {"domain": domain})

    async def forget_all(self) -> None:
        await self._call("guard.forgetAll")


def wrap_page(
    client: "Unstuck",
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
    if isinstance(getattr(page, "unstuck", None), PageGuard):
        return page
    if not inspect.iscoroutinefunction(getattr(page, "goto", None)):
        raise TypeError(SYNC_PAGE)
    opts: dict[str, Any] = {"profile": profile, "rescue": list(rescue), "remember": remember, "maxRescuesPerHour": max_rescues_per_hour}
    for key, value in (("timeoutS", timeout_s), ("allowedSites", allowed_sites), ("alerts", alerts), ("requireCode", require_code), ("approvalTimeoutS", approval_timeout_s)):
        if value is not None:
            opts[key] = list(value) if key == "allowedSites" else value
    guard = PageGuard(client, page, opts, on_rescue, on_rescue_fail)

    def navigating(name: str) -> None:
        original = getattr(page, name)

        async def guarded(*args: Any, **kwargs: Any) -> Any:
            url = args[0] if name == "goto" and args and isinstance(args[0], str) else kwargs.get("url") if name == "goto" else None
            return await guard.run(lambda: original(*args, **kwargs), url=url, navigates=True)

        setattr(page, name, guarded)

    def acting(name: str, may_navigate: bool) -> None:
        original = getattr(page, name)

        async def guarded(*args: Any, **kwargs: Any) -> Any:
            return await guard.run(lambda: original(*args, **kwargs), navigates=False, may_navigate=may_navigate)

        setattr(page, name, guarded)

    def factory(name: str) -> None:
        original = getattr(page, name)
        setattr(page, name, lambda *a, **k: _guard_locator(original(*a, **k), guard.run))

    for name in _NAVIGATING:
        navigating(name)
    for name, may in _ACTING.items():
        acting(name, may)
    for name in LOCATOR_FACTORIES:
        factory(name)
    expect_navigation = page.expect_navigation
    page.expect_navigation = lambda *a, **k: _GuardedNavigation(guard, expect_navigation(*a, **k))
    page.unstuck = guard
    return page
