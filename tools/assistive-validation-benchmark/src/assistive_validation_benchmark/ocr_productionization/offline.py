from __future__ import annotations

import socket
from typing import Any


class OfflineNetworkBlocked(RuntimeError):
    pass


def enable_offline_guard() -> dict[str, Any]:
    def blocked(*_args: Any, **_kwargs: Any) -> Any:
        raise OfflineNetworkBlocked("network disabled by pp1 OCR benchmark offline guard")

    socket.create_connection = blocked  # type: ignore[assignment]
    socket.socket.connect = blocked  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked  # type: ignore[method-assign]
    self_test = False
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=0.01)
    except OfflineNetworkBlocked:
        self_test = True
    if not self_test:
        raise RuntimeError("offline network guard self-test failed")
    return {
        "enabled": True,
        "mechanism": "process-wide Python socket connect/create_connection/connect_ex denial",
        "self_test_passed": True,
    }
