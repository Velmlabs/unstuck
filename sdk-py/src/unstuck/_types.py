from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

TakeoverStatus = Literal["resolved", "timed_out", "cancelled", "failed"]


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

    @classmethod
    def from_wire(cls, d: Mapping[str, Any]) -> "TakeoverLink":
        return cls(url=d["url"], reason=d["reason"], session_id=d["sessionId"], expires_at=d["expiresAt"])
