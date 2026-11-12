import asyncio
import json

import pytest

from conftest import CASES
from unstuck._rpc import RpcCallError, RpcPeer

CASE_LIST = json.loads(CASES.read_text(encoding="utf-8"))["cases"]


def make_pair():
    loop = asyncio.get_running_loop()
    holder = {}
    a = RpcPeer(lambda line: loop.call_soon(holder["b"].receive, line))
    b = RpcPeer(lambda line: loop.call_soon(holder["a"].receive, line))
    holder["a"], holder["b"] = a, b
    return a, b


def test_has_cases():
    assert len(CASE_LIST) > 5


@pytest.mark.parametrize("case", CASE_LIST, ids=[c["name"] for c in CASE_LIST])
async def test_shared_case(case):
    a, b = make_pair()
    for s in case["steps"]:
        if "handle" in s:

            def handler(params, s=s):
                if "throws" in s:
                    err = RuntimeError(s["throws"]["message"])
                    if "code" in s["throws"]:
                        err.code = s["throws"]["code"]
                    raise err
                if s.get("echo"):
                    return params
                if s.get("async"):

                    async def later():
                        await asyncio.sleep(0)
                        return s["returns"]

                    return later()
                return s["returns"]

            b.handle(s["handle"], handler)
        elif "request" in s:
            if "result" in s["expect"]:
                assert await a.request(s["request"], s.get("params")) == s["expect"]["result"]
            else:
                with pytest.raises(RpcCallError) as info:
                    await a.request(s["request"], s.get("params"))
                for k, v in s["expect"]["error"].items():
                    assert getattr(info.value, k if k != "message" else "message") == v
        elif "receive" in s:
            a.receive(s["receive"])
        elif "close" in s:
            a.close(s["close"])
        else:  # pragma: no cover - guards against malformed case files
            raise AssertionError(f"unknown step {s}")


async def test_notifications_reach_listeners_and_unheard_ones_are_ignored():
    a, b = make_pair()
    got = []
    b.on_notification("ev", got.append)
    a.notify("ev", {"k": 1})
    a.notify("unheard")
    await asyncio.sleep(0.01)
    assert got == [{"k": 1}]


def test_lines_are_compact_json_and_keep_unicode():
    lines = []
    RpcPeer(lines.append).notify("a", {"x": "日本"})
    assert lines == ['{"method":"a","params":{"x":"日本"}}']


async def test_close_rejects_pending_requests():
    a, b = make_pair()
    b.handle("slow", lambda p: asyncio.get_running_loop().create_future())
    pending = asyncio.ensure_future(a.request("slow"))
    await asyncio.sleep(0.01)
    a.close("bye")
    with pytest.raises(RpcCallError) as info:
        await pending
    assert info.value.code == "closed" and str(info.value) == "bye"


def test_rpc_call_error_exposes_code_and_message():
    e = RpcCallError("closed", "gone")
    assert (e.code, e.message, str(e)) == ("closed", "gone", "gone")
