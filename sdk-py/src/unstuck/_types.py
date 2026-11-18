from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

TakeoverStatus = Literal["resolved", "timed_out", "cancelled", "failed"]
CheckKind = Literal["challenge", "approval", "login", "2fa"]
RescueStatus = Literal[
    "resolved", "still_blocked", "timed_out", "cancelled", "rescue_limited", "alert_failed", "browser_cannot_render_captcha", "failed"
]


@dataclass(frozen=True)
class TakeoverResult:
    status: TakeoverStatus
    session_id: str
    url: str
    duration_s: float
    detail: str | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "TakeoverResult":
        return cls(status=d["status"], session_id=d["sessionId"], url=d["url"], duration_s=d["durationS"], detail=d.get("detail"))


@dataclass(frozen=True)
class TakeoverLink:
    url: str
    reason: str
    session_id: str
    expires_at: int
    code: str | None = None
    """The 6-digit code to give the human, when the takeover requires one. Never part of ``url``."""

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "TakeoverLink":
        return cls(url=d["url"], reason=d["reason"], session_id=d["sessionId"], expires_at=d["expiresAt"], code=d.get("code"))


AskStatus = Literal["answered", "timed_out", "cancelled", "failed"]


@dataclass(frozen=True)
class AskAnswer:
    """The person's answer: the chosen ``choice`` index and its ``label``, and/or typed ``text``."""

    choice: int | None = None
    label: str | None = None
    text: str | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "AskAnswer":
        return cls(choice=d.get("choice"), label=d.get("label"), text=d.get("text"))


@dataclass(frozen=True)
class AskResult:
    status: AskStatus
    answer: AskAnswer | None
    via: str | None
    duration_s: float
    session_id: str
    detail: str | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "AskResult":
        a = d.get("answer")
        return cls(
            status=d["status"], answer=AskAnswer.from_wire(a) if a else None, via=d.get("via"), duration_s=d["durationS"],
            session_id=d["sessionId"], detail=d.get("detail"),
        )


@dataclass(frozen=True)
class HumanCheck:
    """What the guard detected: a challenge (CAPTCHA), a login, a 2FA code, or ``ask`` for ``ask_human``."""

    kind: str
    rule_id: str
    evidence: list[str]
    url: str
    site: str
    vendor: str | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "HumanCheck":
        return cls(kind=d["kind"], rule_id=d["ruleId"], evidence=list(d.get("evidence") or []), url=d["url"], site=d["site"], vendor=d.get("vendor"))


@dataclass(frozen=True)
class RescueEvent:
    """One rescue: what was detected, how it ended, and how long the person took."""

    status: RescueStatus
    check: HumanCheck
    waited_s: float
    detail: str | None = None
    takeover: TakeoverResult | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "RescueEvent":
        t = d.get("takeover")
        return cls(
            status=d["status"],
            check=HumanCheck.from_wire(d["check"]),
            waited_s=d["waitedS"],
            detail=d.get("detail"),
            takeover=TakeoverResult.from_wire(t) if t else None,
        )


@dataclass(frozen=True)
class StoredCookie:
    name: str
    value: str
    domain: str
    path: str
    expires: float
    """Seconds since the epoch; -1 for a session cookie."""
    http_only: bool
    secure: bool
    same_site: str | None = None

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "StoredCookie":
        return cls(
            name=d["name"], value=d["value"], domain=d["domain"], path=d["path"], expires=d["expires"],
            http_only=d["httpOnly"], secure=d["secure"], same_site=d.get("sameSite"),
        )


@dataclass(frozen=True)
class SiteSession:
    """A site's cookies and the browser's user agent, e.g. to hand to an HTTP client."""

    site: str
    user_agent: str
    cookies: list[StoredCookie]
    cookie_header: str

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "SiteSession":
        return cls(site=d["site"], user_agent=d["userAgent"], cookies=[StoredCookie.from_wire(c) for c in d["cookies"]], cookie_header=d["cookieHeader"])
