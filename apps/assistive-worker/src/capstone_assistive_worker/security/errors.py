from __future__ import annotations

from dataclasses import dataclass

from ..contract import ErrorCode


@dataclass(frozen=True, slots=True)
class ExtractionFailure(Exception):
    code: ErrorCode
    safe_message: str

    def __str__(self) -> str:
        return self.safe_message
