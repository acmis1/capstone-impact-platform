"""Host-load control for the repeated latency calibration.

This benchmark runs on a shared developer workstation. A repeat measured while an unrelated
workload occupies the CPU characterises the host, not the candidate, so external load is a
controlled variable rather than an unrecorded confound:

* before a repeat starts, external CPU utilisation is sampled and the runner waits, up to a
  bounded time, until the host is quiet;
* throughout the repeat, external utilisation is sampled once a second and summarised;
* a repeat whose mean external utilisation exceeds the frozen ceiling is recorded and marked
  contaminated, and a contaminated repeat can never satisfy the calibration margin.

The control is symmetric: it is declared before any candidate is measured, applies identically
to every candidate, and changes no quality, safety or latency gate.
"""

from __future__ import annotations

import threading
import time
from typing import Any


class HostLoadSampler:
    """Samples system-wide CPU utilisation minus this process's own share."""

    def __init__(self, interval_seconds: float = 1.0) -> None:
        import psutil

        self._interval = max(0.2, float(interval_seconds))
        self._process = psutil.Process()
        self._cpu_count = psutil.cpu_count() or 1
        self._psutil = psutil
        self._samples: list[float] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _external_percent(self) -> float:
        system = float(self._psutil.cpu_percent(interval=self._interval))
        own = float(self._process.cpu_percent(interval=None)) / self._cpu_count
        return max(0.0, min(100.0, system - own))

    def prime(self) -> None:
        """Discard the first reading, which psutil defines relative to process start."""
        self._psutil.cpu_percent(interval=None)
        self._process.cpu_percent(interval=None)
        time.sleep(self._interval)
        self._psutil.cpu_percent(interval=None)
        self._process.cpu_percent(interval=None)

    def measure(self, seconds: float) -> float:
        """Mean external utilisation over a bounded observation window."""
        readings = [self._external_percent() for _ in range(max(1, int(seconds / self._interval)))]
        return sum(readings) / len(readings)

    def start(self) -> None:
        def sample() -> None:
            while not self._stop.is_set():
                self._samples.append(self._external_percent())

        self._thread = threading.Thread(target=sample, name="host-load-sampler", daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        samples = list(self._samples)
        return {
            "sample_count": len(samples),
            "mean_external_cpu_percent": round(sum(samples) / len(samples), 3) if samples else None,
            "maximum_external_cpu_percent": round(max(samples), 3) if samples else None,
        }
def await_quiet_host(control: dict[str, Any]) -> dict[str, Any]:
    """Block until external CPU utilisation is below the frozen ceiling, or refuse to start."""
    sampler = HostLoadSampler(control["sampling_interval_seconds"])
    sampler.prime()
    ceiling = float(control["maximum_external_cpu_percent"])
    window = float(control["precondition_sample_seconds"])
    deadline = time.monotonic() + float(control["precondition_maximum_wait_seconds"])
    attempts = []
    while True:
        observed = sampler.measure(window)
        attempts.append(round(observed, 3))
        if observed <= ceiling:
            return {
                "schema_version": "pp1-ocr-title-fullpage-host-precondition/v1",
                "satisfied": True,
                "maximum_external_cpu_percent": ceiling,
                "observed_external_cpu_percent": round(observed, 3),
                "attempts": attempts,
            }
        if time.monotonic() >= deadline:
            raise ValueError(
                "the host stayed too busy with unrelated work to measure this repeat: "
                f"mean external CPU {observed:.1f}% exceeds the {ceiling:.1f}% ceiling"
            )
        time.sleep(window)
