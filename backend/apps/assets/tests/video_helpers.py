"""Builders for tiny test clips. ffmpeg writes them, so the tests skip themselves when it is missing."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

FFMPEG = shutil.which("ffmpeg")

requires_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not installed")

#: The encoders we try, in order: H.264 in MP4 first, then the plain MPEG-4 part 2 every build has.
_VIDEO_ENCODERS = {"mp4": ("libx264", "mpeg4"), "webm": ("libvpx-vp9", "libvpx")}


def _write(
    path: Path, *, seconds: float, size: tuple[int, int], fps: int, sound: bool, container: str
) -> None:
    width, height = size
    command = [
        FFMPEG,
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc=size={width}x{height}:rate={fps}",
    ]
    if sound:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"]
    command += ["-t", f"{seconds:.3f}"]
    for encoder in _VIDEO_ENCODERS[container]:
        attempt = [*command, "-c:v", encoder, "-pix_fmt", "yuv420p"]
        if sound:
            attempt += ["-c:a", "aac", "-b:a", "64k"]
        if container == "mp4":
            attempt += ["-movflags", "+faststart"]
        attempt.append(str(path))
        done = subprocess.run(attempt, capture_output=True, check=False)
        if done.returncode == 0:
            return
    raise AssertionError(f"ffmpeg could not write the clip: {done.stderr.decode(errors='ignore')[:400]}")


def clip_bytes(
    *,
    seconds: float = 1.0,
    size: tuple[int, int] = (320, 240),
    fps: int = 25,
    sound: bool = False,
    container: str = "mp4",
) -> bytes:
    """A small clip written by ffmpeg; its bytes are what an upload would carry."""
    with tempfile.TemporaryDirectory(prefix="doory-clip-") as folder:
        path = Path(folder) / f"clip.{container}"
        _write(path, seconds=seconds, size=size, fps=fps, sound=sound, container=container)
        return path.read_bytes()
