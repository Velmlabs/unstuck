"""Bidirectional JSON-lines RPC, the Python twin of protocol/src/rpc.ts (see protocol/cases/rpc.json)."""

from __future__ import annotations

import asyncio
import inspect
import json
from typing import Any, Awaitable, Callable

PROTOCOL_VERSION = 1
PROTOCOL_MINOR = 2


class RpcCallError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RpcPeer:
    def __init__(self, write: Callable[[str], None]) -> None:
        self._write = write
        self._next_id = 1
        self._closed: str | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._handlers: dict[str, Callable[[Any], Any | Awaitable[Any]]] = {}
        self._listeners: dict[str, list[Callable[[Any], None]]] = {}

    def _send(self, msg: dict[str, Any]) -> None:
        self._write(json.dumps(msg, separators=(",", ":"), ensure_ascii=False))

    async def request(self, method: str, params: Any = None) -> Any:
        if self._closed is not None:
            raise RpcCallError("closed", self._closed)
        msg_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        self._send({"id": msg_id, "method": method, "params": params})
        return await fut

    def notify(self, method: str, params: Any = None) -> None:
        self._send({"method": method, "params": params})

    def handle(self, method: str, fn: Callable[[Any], Any | Awaitable[Any]]) -> None:
        self._handlers[method] = fn

    def on_notification(self, method: str, fn: Callable[[Any], None]) -> None:
        self._listeners.setdefault(method, []).append(fn)

    async def _on_request(self, msg_id: int, method: str, params: Any) -> None:
        fn = self._handlers.get(method)
        if fn is None:
            self._send({"id": msg_id, "error": {"code": "unknown_method", "message": f"unknown method {method}"}})
            return
        try:
            result = fn(params)
            if inspect.isawaitable(result):
                result = await result
            self._send({"id": msg_id, "result": result})
        except Exception as e:  # noqa: BLE001 - every handler error goes back to the caller
            code = getattr(e, "code", None)
            self._send({"id": msg_id, "error": {"code": code if isinstance(code, str) else "handler_error", "message": str(e)}})

    def receive(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        msg_id, method = msg.get("id"), msg.get("method")
        if isinstance(msg_id, int) and isinstance(method, str):
            asyncio.ensure_future(self._on_request(msg_id, method, msg.get("params")))
        elif isinstance(msg_id, int):
            fut = self._pending.pop(msg_id, None)
            if fut is None or fut.done():
                return
            err = msg.get("error")
            if err:
                fut.set_exception(RpcCallError(err.get("code", "handler_error"), err.get("message", "")))
            else:
                fut.set_result(msg.get("result"))
        elif isinstance(method, str):
            for fn in list(self._listeners.get(method, [])):
                fn(msg.get("params"))

    def close(self, reason: str) -> None:
        self._closed = reason
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RpcCallError("closed", reason))
        self._pending.clear()
