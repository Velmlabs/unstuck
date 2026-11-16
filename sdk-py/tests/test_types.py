from unstuck import PageClosedError, TakeoverLink, TakeoverResult, UnstuckEngineError, __version__
from unstuck._rpc import PROTOCOL_VERSION


def test_takeover_result_from_wire_maps_camel_case():
    r = TakeoverResult.from_wire({"status": "failed", "sessionId": "s", "url": "u", "durationS": 1.5, "detail": "page_closed"})
    assert r == TakeoverResult(status="failed", session_id="s", url="u", duration_s=1.5, detail="page_closed")


def test_takeover_result_detail_is_optional():
    assert TakeoverResult.from_wire({"status": "resolved", "sessionId": "s", "url": "u", "durationS": 0}).detail is None


def test_link_from_wire():
    l = TakeoverLink.from_wire({"url": "http://x", "reason": "r", "sessionId": "s", "expiresAt": 5, "pageId": "p"})
    assert l == TakeoverLink(url="http://x", reason="r", session_id="s", expires_at=5)


def test_link_code_is_optional():
    l = TakeoverLink.from_wire({"url": "u", "reason": "r", "sessionId": "s", "expiresAt": 1, "code": "123456"})
    assert l.code == "123456"
    assert TakeoverLink.from_wire({"url": "u", "reason": "r", "sessionId": "s", "expiresAt": 1}).code is None


def test_errors_and_versions():
    e = UnstuckEngineError("boom", engine_path="/x")
    assert str(e) == "boom" and e.engine_path == "/x"
    assert UnstuckEngineError("b").engine_path is None
    assert str(PageClosedError()) == "page closed"
    assert PROTOCOL_VERSION == 1 and __version__ == "0.2.2"
