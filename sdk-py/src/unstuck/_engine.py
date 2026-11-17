"""Starts the unstuck-engine binary and speaks JSON lines to it (mirrors sdk-ts/src/engine-process.ts)."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Mapping

from ._errors import UnstuckEngineError
from ._rpc import PROTOCOL_MINOR, PROTOCOL_VERSION, RpcCallError, RpcPeer
from ._version import __version__

HINT = "Set UNSTUCK_ENGINE_PATH to a working unstuck-engine binary."
HANDSHAKE_TIMEOUT_S = 15.0


def _bundled_path() -> Path:
    name = "unstuck-engine.exe" if sys.platform == "win32" else "unstuck-engine"
    return Path(__file__).parent / "_bin" / name


def resolve_engine_path(engine_path: str | None, env: Mapping[str, str] = os.environ) -> str:
    """Explicit argument → UNSTUCK_ENGINE_PATH → binary bundled in the wheel."""
    if engine_path:
        return engine_path
    if env.get("UNSTUCK_ENGINE_PATH"):
        return env["UNSTUCK_ENGINE_PATH"]
    bundled = _bundled_path()
    if bundled.exists():
        return str(bundled)
    raise UnstuckEngineError(
        f"Unstuck engine not found. Tried: the engine_path argument, UNSTUCK_ENGINE_PATH, and the bundled binary {bundled}. "
        "Install a platform wheel of unstuck, or set UNSTUCK_ENGINE_PATH to the unstuck-engine binary."
    )


class EngineProcess:
    def __init__(self, proc: asyncio.subprocess.Process, peer: RpcPeer, reader: asyncio.Task[None]) -> None:
        self._proc = proc
        self.peer = peer
        self._reader = reader
        self.engine_version = ""
        self.capabilities: frozenset[str] = frozenset()
        """What the engine offers beyond takeovers (empty for an engine older than protocol minor 1)."""

    async def wait(self) -> int | None:
        code = await self._proc.wait()
        await asyncio.gather(self._reader, return_exceptions=True)
        return code

    def kill(self) -> None:
        if self._proc.returncode is None:
            self._proc.kill()

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode


async def spawn_engine(
    path: str,
    *,
    host: str | None = None,
    port: int | None = None,
    relay: str | None = None,
    agent_key: str | None = None,
    handshake_timeout_s: float = HANDSHAKE_TIMEOUT_S,
) -> EngineProcess:
    args = ["--stdio"]
    if host:
        args += ["--host", host]
    if port is not None:
        args += ["--port", str(port)]
    try:
        # Relay mode is chosen by the engine from its environment (relay spec 5.6).
        env = dict(os.environ)
        if relay:
            env["UNSTUCK_RELAY_URL"] = relay
        if agent_key:
            env["UNSTUCK_AGENT_KEY"] = agent_key
        proc = await asyncio.create_subprocess_exec(
            path, *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=None, limit=16 * 1024 * 1024, env=env
        )
    except OSError as e:
        raise UnstuckEngineError(f"could not start the Unstuck engine at {path}: {e.strerror or e}. {HINT}", path) from e

    assert proc.stdin is not None and proc.stdout is not None
    stdin, stdout = proc.stdin, proc.stdout

    def write(line: str) -> None:
        if not stdin.is_closing():
            stdin.write((line + "\n").encode())

    peer = RpcPeer(write)

    async def read() -> None:
        while line := await stdout.readline():
            peer.receive(line.decode())
        code = await proc.wait()
        peer.close(f"engine exited with code {code}")

    engine = EngineProcess(proc, peer, asyncio.ensure_future(read()))
    try:
        hello = await asyncio.wait_for(
            peer.request("engine.hello", {"sdk": "py", "sdkVersion": __version__, "protocolVersion": PROTOCOL_VERSION, "protocolMinor": PROTOCOL_MINOR}),
            timeout=handshake_timeout_s,
        )
    except asyncio.TimeoutError:
        engine.kill()
        await engine.wait()
        raise UnstuckEngineError(
            f"the Unstuck engine at {path} did not answer the handshake within {handshake_timeout_s:g} s. {HINT}", path
        ) from None
    except RpcCallError as e:
        engine.kill()
        code = await engine.wait()
        if e.code == "closed":
            raise UnstuckEngineError(f"the Unstuck engine at {path} exited with code {code} before the handshake. {HINT}", path) from None
        raise UnstuckEngineError(f"the Unstuck engine at {path} refused the handshake: {e.message}. {HINT}", path) from None
    engine.engine_version = hello["engineVersion"]
    engine.capabilities = frozenset(hello.get("capabilities") or ())
    return engine
