from __future__ import annotations


class UnstuckEngineError(Exception):
    """The engine binary could not be found, started, or kept running."""

    def __init__(self, message: str, engine_path: str | None = None) -> None:
        super().__init__(message)
        self.engine_path = engine_path


class PageClosedError(Exception):
    """The page was already closed when Unstuck tried to attach."""

    def __init__(self) -> None:
        super().__init__("page closed")
