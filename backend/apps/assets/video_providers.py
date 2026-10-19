"""Stock-video providers: Pexels and Pixabay clips, searched and imported like stock photos.

The client only ever names a provider and a clip id. The file URL comes from the provider's API and must
stay on that provider's video host over https for every hop (redirects are followed manually and
re-checked), so a hostile answer or a hostile client can never aim the server at an arbitrary host.

Each provider has its own key, its own rate limit and its own cache time (`STOCK_<NAME>_RATE`,
`STOCK_<NAME>_CACHE_SECONDS`), so a busy video key never slows the photo search down. A video key falls
back to the photo key of the same provider when it is not set.
"""

from __future__ import annotations

import re
import time
from abc import abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from django.conf import settings
from django.core.cache import cache

from . import providers
from .providers import (
    ProviderBase,
    ProviderError,
    _as_int,
    _as_str,
    _dict,
    _https_link,
    _is_count,
    _next_page,
    _seconds,
    check_https_host,
)

MAX_PER_PAGE = 20
#: The shapes a clip can have; "all" asks for none of them.
ORIENTATIONS = ("all", "landscape", "portrait", "square")
#: How long a resolved clip is remembered, so an import right after a search costs no call.
RESOLVE_CACHE_SECONDS = 10 * 60
_ID = re.compile(r"[0-9]{1,12}")


@dataclass(frozen=True)
class StockVideo:
    id: str
    provider: str
    thumb_url: str
    preview_url: str
    width: int
    height: int
    duration_ms: int
    author: str
    author_url: str
    source_url: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": self.provider,
            "thumb_url": self.thumb_url,
            "preview_url": self.preview_url,
            "width": self.width,
            "height": self.height,
            "duration_ms": self.duration_ms,
            "author": self.author,
            "author_url": self.author_url,
            "source_url": self.source_url,
        }


@dataclass(frozen=True)
class VideoSearchPage:
    total: int
    next_page: int | None
    results: list[StockVideo]


@dataclass(frozen=True)
class ResolvedVideo:
    video: StockVideo
    download_url: str
    preview_url: str


def orientation_of(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "landscape"
    if width == height:
        return "square"
    return "landscape" if width > height else "portrait"


def _pick_file(files: object, hosts: frozenset[str], *, largest: bool) -> str | None:
    """The link of the largest (or the smallest) file the provider offers, when it is on an allowed host."""
    if not isinstance(files, list):
        return None
    best: tuple[int, str] | None = None
    for entry in files:
        if not isinstance(entry, dict):
            continue
        link = entry.get("link")
        if not isinstance(link, str) or not link:
            continue
        try:
            checked = check_https_host(link, hosts)
        except ProviderError:
            continue
        size = _as_int(entry.get("width")) * 100_000 + _as_int(entry.get("height"))
        if best is None or (size > best[0] if largest else size < best[0]):
            best = (size, checked)
    return best[1] if best else None


class VideoProvider(ProviderBase):
    """A provider of stock clips: it searches, it resolves a clip to a file, and it names its own hosts."""

    video_hosts: frozenset[str]
    thumb_hosts: frozenset[str]
    max_results: int | None = None
    url_lifetime_seconds: int | None = None  # how long the clip URLs in a search answer keep working

    @property
    def configured(self) -> bool:
        """On: it has a key. The clip tab is a tab of its own, so `STOCK_PROVIDERS` does not apply."""
        return bool(self._key())

    def remember(self, resolved: ResolvedVideo) -> None:
        """Kept, so an import or a preview right after a search costs no call."""
        cache.set(f"stockvideo:{self.name}:{resolved.video.id}", resolved, RESOLVE_CACHE_SECONDS)

    def remembered(self, video_id: str) -> ResolvedVideo | None:
        found = cache.get(f"stockvideo:{self.name}:{video_id}")
        return found if isinstance(found, ResolvedVideo) else None

    @abstractmethod
    def valid_id(self, video_id: str) -> bool: ...

    @abstractmethod
    def search(
        self, query: str, page: int, per_page: int, options: Mapping[str, str] | None = None
    ) -> VideoSearchPage: ...

    @abstractmethod
    def resolve(self, video_id: str) -> ResolvedVideo: ...

    def _checked(self, url: object, hosts: frozenset[str]) -> str | None:
        try:
            return check_https_host(url, hosts) if isinstance(url, str) else None
        except ProviderError:
            return None


class PexelsVideoProvider(VideoProvider):
    """Pexels has no "one clip" endpoint, so a clip is remembered from the search that found it."""

    name = "pexels_video"
    label = "Pexels"
    attribution = "Videos provided by Pexels"
    home_url = "https://www.pexels.com/"
    video_hosts = frozenset({"videos.pexels.com"})
    thumb_hosts = frozenset({"images.pexels.com"})
    api = "https://api.pexels.com/v1"

    def _key(self) -> str:
        return settings.PEXELS_VIDEO_API_KEY or settings.PEXELS_API_KEY

    def _headers(self) -> dict[str, str]:
        return {"Authorization": self._key()}

    def valid_id(self, video_id: str) -> bool:
        return _ID.fullmatch(video_id) is not None

    def _reset_seconds(self, headers: Mapping[str, str]) -> float | None:
        reset = _seconds(headers.get("X-RateLimit-Reset"))  # the Unix time the quota renews
        return reset - time.time() if reset and reset > time.time() else None

    def _resolved(self, item: object) -> ResolvedVideo | None:
        if not isinstance(item, dict) or not _is_count(item.get("id")):
            return None
        files = item.get("video_files")
        preview = _pick_file(files, self.video_hosts, largest=False)
        download = _pick_file(files, self.video_hosts, largest=True)
        thumb = self._checked(item.get("image"), self.thumb_hosts)
        if not preview or not download or not thumb:
            return None
        user = _dict(item.get("user"))
        video = StockVideo(
            id=str(item["id"]),
            provider=self.name,
            thumb_url=thumb,
            preview_url=preview,  # the server's own relayed preview
            width=_as_int(item.get("width")),
            height=_as_int(item.get("height")),
            duration_ms=round(_as_int(item.get("duration")) * 1000),
            author=_as_str(user.get("name")),
            author_url=_https_link(user.get("url")),
            source_url=_https_link(item.get("url")),
        )
        return ResolvedVideo(video=video, download_url=download, preview_url=preview)

    def search(
        self, query: str, page: int, per_page: int, options: Mapping[str, str] | None = None
    ) -> VideoSearchPage:
        options = self.search_options() if options is None else options
        params: dict[str, Any] = {"page": page, "per_page": per_page}
        if query:
            params["query"] = query
        orientation = options.get("orientation", "")
        if orientation and orientation != "all":
            params["orientation"] = orientation
        data = self._api(f"{self.api}/videos/search", params=params)
        if not isinstance(data, dict) or not isinstance(data.get("videos"), list):
            raise ProviderError("Unexpected provider response.")
        found = [resolved for resolved in map(self._resolved, data["videos"]) if resolved]
        for resolved in found:
            self.remember(resolved)
        total = _as_int(data.get("total_results"))
        return VideoSearchPage(total, _next_page(total, page, per_page), [r.video for r in found])

    def resolve(self, video_id: str) -> ResolvedVideo:
        remembered = self.remembered(video_id)
        if remembered is None:
            raise ProviderError("This clip is no longer known; search for it again.")
        return remembered


class PixabayVideoProvider(VideoProvider):
    """Pixabay takes its key as a query parameter, so it must never be logged or shown."""

    name = "pixabay_video"
    label = "Pixabay"
    attribution = "Videos from Pixabay"
    home_url = "https://pixabay.com/"
    video_hosts = frozenset({"cdn.pixabay.com"})
    thumb_hosts = frozenset({"cdn.pixabay.com"})
    api = "https://pixabay.com/api/videos/"
    max_results = 500  # the API pages through at most 500 hits per query
    url_lifetime_seconds = 24 * 60 * 60  # the clip URLs expire after 24 h
    min_per_page, max_per_page, max_query = 3, 200, 100

    def _key(self) -> str:
        return settings.PIXABAY_VIDEO_API_KEY or settings.PIXABAY_API_KEY

    def _headers(self) -> dict[str, str]:
        return {}

    def _api(self, url: str, params: dict[str, Any] | None = None) -> Any:
        return super()._api(url, {"key": self._key(), **(params or {})})

    def valid_id(self, video_id: str) -> bool:
        return _ID.fullmatch(video_id) is not None

    def _reset_seconds(self, headers: Mapping[str, str]) -> float | None:
        return _seconds(headers.get("X-RateLimit-Reset"))  # seconds left in the 60 s window

    def search_options(self, lang: str = "") -> dict[str, str]:
        return {"safesearch": "true" if self.config.safesearch else "false"}

    def _variant(self, variants: object, name: str) -> str | None:
        """The URL of one file variant ("large", "medium", …), when it is on an allowed host."""
        entry = _dict(variants).get(name)
        url = entry.get("url") if isinstance(entry, dict) else None
        return self._checked(url, self.video_hosts)

    def _resolved(self, item: object) -> ResolvedVideo | None:
        if not isinstance(item, dict) or not _is_count(item.get("id")):
            return None
        variants = item.get("videos")
        preview = self._variant(variants, "tiny") or self._variant(variants, "small")
        download = self._variant(variants, "large") or self._variant(variants, "medium")
        thumb = self._checked(item.get("image"), self.thumb_hosts)
        if not preview or not download or not thumb:
            return None
        user = _as_str(item.get("user"), 100)
        user_id = item.get("user_id")
        author_url = (
            f"https://pixabay.com/users/{quote(user, safe='')}-{user_id}/"
            if user and _is_count(user_id)
            else ""
        )
        large = _dict(_dict(variants).get("large"))
        video = StockVideo(
            id=str(item["id"]),
            provider=self.name,
            thumb_url=thumb,
            preview_url=preview,  # the server's own relayed preview
            width=_as_int(large.get("width")),
            height=_as_int(large.get("height")),
            duration_ms=round(_as_int(item.get("duration")) * 1000),
            author=user,
            author_url=author_url,
            source_url=_https_link(item.get("pageURL")),
        )
        return ResolvedVideo(video=video, download_url=download, preview_url=preview)

    def search(
        self, query: str, page: int, per_page: int, options: Mapping[str, str] | None = None
    ) -> VideoSearchPage:
        options = self.search_options() if options is None else options
        asked = min(max(per_page, self.min_per_page), self.max_per_page)
        params: dict[str, Any] = {"page": page, "per_page": asked, **options}
        if query:
            params["q"] = query[: self.max_query]
        data = self._api(self.api, params=params)
        if not isinstance(data, dict) or not isinstance(data.get("hits"), list):
            raise ProviderError("Unexpected provider response.")
        total = min(_as_int(data.get("totalHits")), self.max_results)
        found = [resolved for resolved in map(self._resolved, data["hits"]) if resolved][:per_page]
        for resolved in found:
            self.remember(resolved)
        orientation = options.get("orientation", "")
        videos = [r.video for r in found]
        if orientation and orientation != "all":
            videos = [v for v in videos if orientation_of(v.width, v.height) == orientation]
        return VideoSearchPage(
            total, _next_page(total, page, per_page) if asked == per_page else None, videos
        )

    def resolve(self, video_id: str) -> ResolvedVideo:
        remembered = self.remembered(video_id)
        if remembered is not None:
            return remembered
        data = self._api(self.api, params={"id": video_id})
        hits = data.get("hits") if isinstance(data, dict) else None
        item = hits[0] if isinstance(hits, list) and hits else None
        resolved = self._resolved(item)
        if resolved is None or resolved.video.id != video_id:
            raise ProviderError("Unexpected provider response.")
        self.remember(resolved)
        return resolved


VIDEO_PROVIDERS: dict[str, VideoProvider] = {
    p.name: p for p in (PexelsVideoProvider(), PixabayVideoProvider())
}


def configured_providers() -> list[VideoProvider]:
    """The clip providers that are on, in a fixed order."""
    return [provider for provider in VIDEO_PROVIDERS.values() if provider.configured]


def provider_for(name: str) -> VideoProvider | None:
    provider = VIDEO_PROVIDERS.get(name)
    return provider if provider and provider.configured else None


def download_clip(url: str, *, hosts: frozenset[str], max_bytes: int) -> bytes:
    """Fetch a clip (https, allow-listed host on every redirect hop) with a byte cap and a deadline."""
    return providers.download_image(url, hosts=hosts, max_bytes=max_bytes, accept="video/*")
