"""Upload pipeline: content sniffing, sanitising, quota and storage for user assets."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.etree.ElementTree import ParseError

from defusedxml.common import DefusedXmlException
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile, File
from django.db import transaction
from django.db.models import Sum

from apps.core import svg
from apps.core.images import ImageBusy, ImageError, make_thumbnail, process_image_upload

from . import video
from .audio import AudioError, VideoInAudio, looks_like_audio, parse_audio
from .exceptions import FileTooLarge, InvalidFile, QuotaExceeded, ServerBusy, VideoDisabled
from .models import Asset
from .storage import delete_files

MAX_SVG_DIMENSION = 12_000
_BOM = b"\xef\xbb\xbf"
#: The name of a clip's sound, which is an asset of its own.
_SOUND_SUFFIX = " (audio)"


@dataclass(frozen=True)
class PreparedFile:
    kind: str
    data: bytes
    mime: str
    ext: str
    width: int
    height: int
    thumbnail: bytes | None
    #: What the file says about itself (audio: codec, channels, rate, duration); merged into `Asset.meta`.
    meta: dict | None = None


def read_upload(uploaded_file) -> bytes:
    """Read an uploaded file into memory with a hard cap (`MAX_UPLOAD_BYTES`)."""
    limit = settings.MAX_UPLOAD_BYTES
    if uploaded_file.size is not None and uploaded_file.size > limit:
        raise FileTooLarge()
    data = uploaded_file.read(limit + 1)
    if len(data) > limit:
        raise FileTooLarge()
    return data


def _looks_like_markup(data: bytes) -> bool:
    head = data[:2048]
    if head.startswith(_BOM):
        head = head[len(_BOM) :]
    return head.lstrip().startswith(b"<")


def _svg_dimensions(width: float, height: float) -> tuple[int, int]:
    scale = min(1.0, MAX_SVG_DIMENSION / max(width, height, 1))
    return max(1, round(width * scale)), max(1, round(height * scale))


def _prepare_svg(data: bytes) -> PreparedFile:
    if len(data) > svg.MAX_BYTES:
        raise FileTooLarge("The SVG is too large.")
    try:
        clean = svg.sanitize_svg(data)
        info = svg.svg_info(clean)
        width, height = _svg_dimensions(info.width, info.height)
        clean = svg.with_intrinsic_size(clean, width, height)
    except (svg.SvgError, DefusedXmlException, ParseError) as exc:
        raise InvalidFile("The file is not a valid, safe SVG.") from exc
    return PreparedFile("svg", clean, "image/svg+xml", "svg", width, height, None)


def _prepare_raster(data: bytes) -> PreparedFile:
    try:
        processed = process_image_upload(BytesIO(data), max_bytes=settings.MAX_UPLOAD_BYTES)
    except ImageBusy as exc:
        raise ServerBusy() from exc
    except ImageError as exc:
        raise InvalidFile(str(exc)) from exc
    try:
        thumbnail: bytes | None = make_thumbnail(processed.data)
    except ImageError:
        thumbnail = None
    return PreparedFile(
        "image", processed.data, processed.mime, processed.ext, processed.width, processed.height, thumbnail
    )


def _prepare_audio(data: bytes) -> PreparedFile:
    try:
        info = parse_audio(data)
    except AudioError as exc:
        raise InvalidFile(f"The audio file could not be read. {exc}") from exc
    return PreparedFile("audio", data, info.mime, info.ext, 0, 0, None, {"audio": info.as_meta()})


def prepare_file(data: bytes) -> PreparedFile:
    """Decide the type from the content (never the filename) and return a safe, normalised copy."""
    if not data:
        raise InvalidFile("The file is empty.")
    if looks_like_audio(data):
        return _prepare_audio(data)
    return _prepare_svg(data) if _looks_like_markup(data) else _prepare_raster(data)


def storage_used(owner) -> int:
    return Asset.objects.filter(owner=owner).aggregate(total=Sum("size"))["total"] or 0


def _read_head(path: Path) -> bytes:
    """The first bytes of a file: enough to recognise its container."""
    with open(path, "rb") as handle:
        return handle.read(16)


def _read_capped(path: Path, limit: int) -> bytes:
    """The bytes of a file, with a hard cap (`limit`)."""
    with open(path, "rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise FileTooLarge()
    return data


@contextmanager
def _upload_path(upload) -> Iterator[Path]:
    """A path for the uploaded file: the temporary file Django already wrote, or a copy of a small one."""
    if hasattr(upload, "temporary_file_path"):
        yield Path(upload.temporary_file_path())
        return
    with TemporaryDirectory(prefix="doory-upload-") as folder:
        path = Path(folder) / "upload"
        with open(path, "wb") as handle:
            for chunk in upload.chunks():
                handle.write(chunk)
        yield path


def create_video_asset(
    owner, path: Path, *, name: str, tags: list[str] | None = None, meta: dict | None = None
) -> Asset:
    """Store a clip: the file as it came, a poster frame, and its sound as an asset of its own.

    The clip is streamed from the file on disk, so a long one is never held in memory. Its sound is stored
    as a second (audio) asset, whose id the clip's metadata carries.
    """
    if not settings.VIDEO_ASSETS_ENABLED:
        raise VideoDisabled()
    size = path.stat().st_size
    if size > settings.MAX_VIDEO_UPLOAD_BYTES:
        raise FileTooLarge("The video is too large.")
    try:
        info = video.probe(path)
    except video.NoVideoTrack:
        # An audio-only container: the audio pipeline knows whether it is a good one.
        return create_asset(owner, _read_capped(path, settings.MAX_UPLOAD_BYTES), name=name, tags=tags)
    poster = video.extract_poster(path, info.duration_ms, (info.width, info.height))
    sound = video.extract_audio(path) if info.has_audio else None
    asset = Asset(
        owner=owner,
        kind=Asset.Kind.VIDEO,
        name=name,
        width=info.width,
        height=info.height,
        size=size,
        mime=info.mime,
        tags=tags or [],
        meta={**(meta or {}), "video": info.as_meta()},
    )
    stored: list[str] = []
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=owner.pk)
            if storage_used(owner) + size + len(sound or b"") > settings.USER_STORAGE_QUOTA_BYTES:
                raise QuotaExceeded()
            with open(path, "rb") as handle:
                asset.file.save(f"{asset.id}.{info.ext}", File(handle), save=False)
            stored.append(asset.file.name)
            if poster:
                asset.thumbnail.save(f"{asset.id}.webp", ContentFile(poster), save=False)
                stored.append(asset.thumbnail.name)
            asset.save()
            if sound:
                companion = Asset(
                    owner=owner,
                    kind=Asset.Kind.AUDIO,
                    name=f"{name[: 255 - len(_SOUND_SUFFIX)]}{_SOUND_SUFFIX}",
                    size=len(sound),
                    mime="audio/mp4",
                    meta={"audio": {"codec": "aac", "duration_ms": info.duration_ms}},
                )
                companion.file.save(f"{companion.id}.m4a", ContentFile(sound), save=False)
                stored.append(companion.file.name)
                companion.save()
                asset.meta["video"]["audio_asset_id"] = str(companion.id)
                asset.save(update_fields=["meta", "updated_at"])
    except Exception:
        delete_files(asset.file.storage, stored)
        raise
    return asset


def create_uploaded_asset(owner, upload, *, name: str, tags: list[str] | None = None) -> Asset:
    """Store an uploaded file; its content decides the pipeline (never its name or the client's type).

    A clip is stored from the file on disk, so a long one is never held in memory. A container that holds
    a video track is a clip; one that holds only sound is audio, and that is settled without ffmpeg.
    """
    with _upload_path(upload) as path:
        if video.looks_like_video(_read_head(path)):
            if path.stat().st_size <= settings.MAX_UPLOAD_BYTES:
                # Small enough for the pure-Python reader: it tells sound and clip apart without ffmpeg.
                data = _read_capped(path, settings.MAX_UPLOAD_BYTES)
                try:
                    prepared = _prepare_audio(data)
                except InvalidFile as exc:
                    if not isinstance(exc.__cause__, VideoInAudio):
                        raise  # not a sound file and not a clip: the file is broken
                else:
                    return store_prepared(owner, prepared, name=name, tags=tags)
            return create_video_asset(owner, path, name=name, tags=tags)
        return create_asset(owner, _read_capped(path, settings.MAX_UPLOAD_BYTES), name=name, tags=tags)


def create_asset(
    owner, data: bytes, *, name: str, tags: list[str] | None = None, meta: dict | None = None
) -> Asset:
    """Validate, store and register an uploaded file for `owner`; enforces the per-user storage quota."""
    return store_prepared(owner, prepare_file(data), name=name, tags=tags, meta=meta)


def store_prepared(
    owner, prepared: PreparedFile, *, name: str, tags: list[str] | None = None, meta: dict | None = None
) -> Asset:
    """Store an already prepared file; enforces the per-user storage quota."""
    asset = Asset(
        owner=owner,
        kind=prepared.kind,
        name=name,
        width=prepared.width,
        height=prepared.height,
        size=len(prepared.data),
        mime=prepared.mime,
        tags=tags or [],
        meta={**(prepared.meta or {}), **(meta or {})},
    )
    stored: list[str] = []
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=owner.pk)
            if storage_used(owner) + asset.size > settings.USER_STORAGE_QUOTA_BYTES:
                raise QuotaExceeded()
            asset.file.save(f"{asset.id}.{prepared.ext}", ContentFile(prepared.data), save=False)
            stored.append(asset.file.name)
            if prepared.thumbnail:
                asset.thumbnail.save(f"{asset.id}.webp", ContentFile(prepared.thumbnail), save=False)
                stored.append(asset.thumbnail.name)
            asset.save()
    except Exception:
        delete_files(asset.file.storage, stored)
        raise
    return asset
