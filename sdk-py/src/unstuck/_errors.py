from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._types import HumanCheck, RescueEvent


class UnstuckEngineError(Exception):
    """The engine binary could not be found, started, or kept running."""

    def __init__(self, message: str, engine_path: str | None = None) -> None:
        super().__init__(message)
        self.engine_path = engine_path


class UnstuckConfigError(ValueError):
    """The options passed to Unstuck are inconsistent (the TypeScript SDK's UnstuckConfigError).

    A subclass of ValueError, which these errors were before, so ``except ValueError`` keeps catching them.
    """


class PageClosedError(Exception):
    """The page was already closed when Unstuck tried to attach."""

    def __init__(self) -> None:
        super().__init__("page closed")


class UnstuckRescueError(Exception):
    """A wrapped page met a human check that a person didn't get it past (see ``status``)."""

    def __init__(self, event: "RescueEvent") -> None:
        detail = f" ({event.detail})" if event.detail else ""
        super().__init__(f"Unstuck could not get past a {event.check.kind} on {event.check.site}: {event.status}{detail}")
        self.status = event.status
        self.detail = event.detail
        self.check: HumanCheck = event.check
        self.event = event
