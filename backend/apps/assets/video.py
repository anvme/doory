"""Video uploads: recognise the container from its bytes, read the clip's facts and make a poster frame.

A clip is stored as it came: Doory never re-encodes it. ffmpeg and ffprobe run as separate processes (never
linked into the project, so no codec licence enters the code) to answer three questions: what the clip holds
(size, duration, frame rate, whether it has sound), what its poster frame looks like, and what its sound alone
sounds like.

The filename and the client's MIME type are never consulted. The feature stays off until an admin turns it on
(`VIDEO_ASSETS_ENABLED`), because ffmpeg parses untrusted input.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings

from apps.core.images import ImageError, make_thumbnail

from .exceptions import InvalidFile, ServerBusy

#: ISO base media brands that mark an image, not a clip.
_IMAGE_BRANDS = frozenset(
    {b"avif", b"avis", b"heic", b"heix", b"hevc", b"heim", b"heis", b"hevm", b"mif1", b"mif2", b"msf1"}
)

#: Container → (mime type, file extension).
CONTAINERS = {
    "mp4": ("video/mp4", "mp4"),
    "mov": ("video/quicktime", "mov"),
    "webm": ("video/webm", "webm"),
    "mkv": ("video/webm", "mkv"),
}

_EBML_MAGIC = b"\x1a\x45\xdf\xa3"
_ISOBMFF_MAGIC = b"ftyp"
_EBML_HEADER = 0x1A45DFA3
_EBML_DOCTYPE = 0x4282


class VideoError(ValueError):
    """The bytes are not a video file Doory can take."""


class NoVideoTrack(VideoError):
    """The container is fine but holds no video track (an audio-only MP4, for example)."""


@dataclass(frozen=True)
class VideoInfo:
    mime: str
    ext: str
    codec: str
    width: int
    height: int
    duration_ms: int
    fps: float | None
    has_audio: bool

    def as_meta(self) -> dict:
        return {
            "codec": self.codec,
            "width": self.width,
            "height": self.height,
            "duration_ms": self.duration_ms,
            "fps": self.fps,
            "has_audio": self.has_audio,
        }


# ---- recognising ---------------------------------------------------------------------------------


def _ebml_id(data: bytes, pos: int) -> tuple[int, int] | None:
    """(id, length) of the EBML element id at `pos`; None when it does not fit."""
    if pos >= len(data):
        return None
    first = data[pos]
    length = 1
    while length <= 4 and not first & (0x80 >> (length - 1)):
        length += 1
    if length > 4 or pos + length > len(data):
        return None
    value = first
    for byte in data[pos + 1 : pos + length]:
        value = (value << 8) | byte
    return value, length


def _ebml_size(data: bytes, pos: int) -> tuple[int, int, bool] | None:
    """(value, length, unknown size) of the EBML variable-length integer at `pos`."""
    if pos >= len(data):
        return None
    first = data[pos]
    length = 1
    while length <= 8 and not first & (0x80 >> (length - 1)):
        length += 1
    if length > 8 or pos + length > len(data):
        return None
    value = first & (0xFF >> length)
    for byte in data[pos + 1 : pos + length]:
        value = (value << 8) | byte
    return value, length, value == (1 << (7 * length)) - 1


def _ebml_doctype(head: bytes) -> str:
    """The container of a Matroska file: "webm" when its DocType says so, "mkv" otherwise."""
    header = _ebml_id(head, 0)
    if header is None or header[0] != _EBML_HEADER:
        return "mkv"
    size = _ebml_size(head, header[1])
    if size is None:
        return "mkv"
    end = len(head) if size[2] else min(len(head), header[1] + size[1] + size[0])
    pos = header[1] + size[1]
    while pos < end:
        element = _ebml_id(head, pos)
        if element is None:
            break
        value = _ebml_size(head, pos + element[1])
        if value is None:
            break
        body = pos + element[1] + value[1]
        if element[0] == _EBML_DOCTYPE:
            doctype = head[body : body + value[0]].decode("ascii", "ignore").lower()
            return "webm" if doctype == "webm" else "mkv"
        pos = body + value[0]
    return "mkv"


def container_of(head: bytes) -> str | None:
    """The container Doory would read this file as ("mp4", "mov", "webm", "mkv"), or None."""
    if head[:4] == _EBML_MAGIC:
        return _ebml_doctype(head)
    if head[4:8] != _ISOBMFF_MAGIC:
        return None
    brand = head[8:12]
    if brand in _IMAGE_BRANDS:
        return None
    return "mov" if brand == b"qt  " else "mp4"


def looks_like_video(head: bytes) -> bool:
    """True when the first bytes claim to be a clip container (never the name, never the client's type)."""
    return container_of(head) is not None


# ---- reading the clip ----------------------------------------------------------------------------


def _run(command: list[str]) -> subprocess.CompletedProcess:
    """Run one of our own tools; a missing binary or a timeout means a busy server, not a broken file."""
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell, our own tools
            command,
            capture_output=True,
            timeout=settings.FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ServerBusy("ffmpeg is not installed on this server.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ServerBusy() from exc


def _rate(stream: dict) -> float | None:
    """The frame rate of a stream ("25/1" → 25.0), or None when the container does not say."""
    for key in ("avg_frame_rate", "r_frame_rate"):
        value = stream.get(key)
        if not isinstance(value, str) or "/" not in value:
            continue
        numerator, _, denominator = value.partition("/")
        try:
            top, bottom = int(numerator), int(denominator)
        except ValueError:
            continue
        if top > 0 and bottom > 0:
            return round(top / bottom, 3)
    return None


def _duration_ms(*sources: dict) -> int:
    """The duration in milliseconds of the first source that states one."""
    for source in sources:
        try:
            seconds = float(source.get("duration"))
        except (TypeError, ValueError):
            continue
        if seconds > 0:
            return round(seconds * 1000)
    return 0


def probe(path: Path) -> VideoInfo:
    """Read the clip's facts with ffprobe. Raises `NoVideoTrack` when the file holds no video."""
    completed = _run(
        [
            settings.FFPROBE_COMMAND,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    if completed.returncode != 0:
        raise InvalidFile("The video could not be read.")
    try:
        payload = json.loads(completed.stdout or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise InvalidFile("The video could not be read.") from exc
    streams = payload.get("streams") or []
    clip = next((s for s in streams if s.get("codec_type") == "video"), None)
    if clip is None:
        if any(s.get("codec_type") == "audio" for s in streams):
            raise NoVideoTrack("The file holds no video track.")
        raise InvalidFile("The video could not be read.")
    with open(path, "rb") as handle:
        head = handle.read(16)
    container = container_of(head)
    if container is None:
        raise InvalidFile("The file is not a video file Doory can take.")
    mime, ext = CONTAINERS[container]
    return VideoInfo(
        mime=mime,
        ext=ext,
        codec=str(clip.get("codec_name") or ""),
        width=int(clip.get("width") or 0),
        height=int(clip.get("height") or 0),
        duration_ms=_duration_ms(clip, payload.get("format") or {}),
        fps=_rate(clip),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
    )


# ---- the poster and the sound ---------------------------------------------------------------------


def _poster_size(size: tuple[int, int] | None) -> str | None:
    """The ffmpeg scale filter that fits the clip inside the poster's longest edge (never enlarging it)."""
    if not size:
        return None
    width, height = size
    if width <= 0 or height <= 0:
        return None
    edge = max(1, settings.VIDEO_POSTER_MAX_EDGE)
    scale = min(1.0, edge / max(width, height))
    return f"scale={max(2, round(width * scale))}:{max(2, round(height * scale))}"


def _poster_at(path: Path, at_ms: int, size: tuple[int, int] | None) -> bytes | None:
    """One frame of the clip as PNG bytes, or None when ffmpeg could not produce one."""
    command = [
        settings.FFMPEG_COMMAND,
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        f"{at_ms / 1000:.3f}",
        "-i",
        str(path),
        "-frames:v",
        "1",
    ]
    scale = _poster_size(size)
    if scale:
        command += ["-vf", scale]
    command += ["-f", "image2pipe", "-vcodec", "png", "-"]
    completed = _run(command)
    if completed.returncode != 0 or not completed.stdout:
        return None
    return completed.stdout


def extract_poster(path: Path, duration_ms: int, size: tuple[int, int] | None = None) -> bytes | None:
    """A WebP poster frame of the clip: what every surface that cannot play video shows.

    The frame is taken a little into the clip (the first tenth of it, at most half a second), because the
    first frame is often black; when that yields nothing the clip is tried again at its very start.
    """
    moment = min(500, max(0, duration_ms) // 10)
    for at in (moment, 0):
        frame = _poster_at(path, at, size)
        if not frame:
            continue
        try:
            return make_thumbnail(frame, max_side=max(1, settings.VIDEO_POSTER_MAX_EDGE))
        except ImageError:
            continue
    return None


def extract_audio(path: Path) -> bytes | None:
    """The clip's sound on its own, as an M4A (AAC), or None when the clip has none.

    The sound is written to a file first: the MP4 muxer needs to seek, which a pipe does not allow.
    """
    with TemporaryDirectory(prefix="doory-sound-") as folder:
        target = Path(folder) / "sound.m4a"
        completed = _run(
            [
                settings.FFMPEG_COMMAND,
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                str(path),
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(target),
            ]
        )
        if completed.returncode != 0 or not target.exists():
            return None
        return target.read_bytes()
