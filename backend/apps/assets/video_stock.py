"""`/stock/videos/` — search stock video (Pexels, Pixabay), preview a clip and copy it into the user's
uploads.

The searches are cached like stock photos (fresh, then a stale copy served when the provider fails), and a
preview is fetched by the server, so the page never talks to the provider and its media policy stays `'self'`.
The clip itself is streamed to a file and stored from there, so a long clip is never held in memory.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from django.conf import settings
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from . import providers, video_providers
from .exceptions import FileTooLarge, StockBusy, StockNotConfigured, StockUnavailable
from .models import Asset
from .serializers import AssetSerializer
from .services import create_video_asset
from .stock import ALL, cached_search, decode_cursor, search_all
from .throttling import StockPreviewRateThrottle, StockRateThrottle, UploadRateThrottle
from .uploads import clean_name

DEFAULT_PER_PAGE = 20
MAX_PAGE = 100
PREVIEW_MAX_BYTES = 12 * 1024 * 1024
PREVIEW_BROWSER_CACHE_SECONDS = 24 * 60 * 60


class VideoSearchSerializer(serializers.Serializer):
    q = serializers.CharField(max_length=100, required=False, allow_blank=True)
    orientation = serializers.ChoiceField(choices=video_providers.ORIENTATIONS, required=False)
    page = serializers.IntegerField(min_value=1, max_value=MAX_PAGE, required=False)
    per_page = serializers.IntegerField(min_value=1, max_value=video_providers.MAX_PER_PAGE, required=False)
    provider = serializers.ChoiceField(choices=(*video_providers.VIDEO_PROVIDERS, ALL), required=False)
    cursor = serializers.CharField(
        max_length=300, required=False, help_text="`next_page` of an `all` search."
    )
    lang = serializers.RegexField(r"^[A-Za-z]{2}([-_][A-Za-z0-9]{1,8})*$", max_length=35, required=False)


class VideoImportSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=video_providers.VIDEO_PROVIDERS)
    id = serializers.CharField(max_length=64)


def info() -> dict[str, Any]:
    """What the clip tab needs to draw itself; `configured: false` hides it."""
    if not settings.VIDEO_ASSETS_ENABLED:
        return {"configured": False, "providers": []}
    configured = video_providers.configured_providers()
    return {
        "configured": bool(configured),
        "providers": [
            {"name": p.name, "label": p.label, "attribution": p.attribution, "url": p.home_url}
            for p in configured
        ],
        "orientations": list(video_providers.ORIENTATIONS),
    }


def _not_configured(provider: str) -> dict[str, Any]:
    return {"configured": False, "provider": provider, "total": 0, "next_page": None, "results": []}


def _pick_provider(requested: str | None) -> video_providers.VideoProvider | None:
    if requested:
        return video_providers.provider_for(requested)
    configured = video_providers.configured_providers()
    return configured[0] if configured else None


def search(
    requested_provider: str | None,
    query: str,
    orientation: str = "all",
    page: int = 1,
    per_page: int = DEFAULT_PER_PAGE,
    lang: str = "",
    cursor: str | None = None,
) -> dict[str, Any]:
    """One page of stock clips, cached per provider. `requested_provider="all"` mixes the providers."""
    query, lang = query.strip(), lang[:2].lower()
    extra = {"orientation": orientation or "all"}
    if requested_provider == ALL:
        chosen = video_providers.configured_providers()
        if not chosen:
            return _not_configured(ALL)
        names = [provider.name for provider in chosen]
        pages = decode_cursor(cursor, names) if cursor else dict.fromkeys(names, 1)
        if not pages:
            raise serializers.ValidationError({"cursor": ["Not a valid cursor."]})
        return search_all([p for p in chosen if p.name in pages], pages, query, per_page, lang, extra=extra)
    provider = _pick_provider(requested_provider)
    if provider is None:
        return _not_configured(requested_provider or "")
    try:
        return cached_search(provider, query, page, per_page, lang, extra=extra)
    except providers.ProviderBusy as exc:
        raise StockBusy(wait=exc.retry_after) from exc
    except providers.ProviderError as exc:
        raise StockUnavailable() from exc


def _resolved(provider_name: str, video_id: str) -> video_providers.ResolvedVideo:
    provider = video_providers.provider_for(provider_name)
    if provider is None:
        raise StockNotConfigured("No stock video provider is configured on this server.")
    if not provider.valid_id(video_id):
        raise serializers.ValidationError({"id": ["Not a valid video id for this provider."]})
    try:
        return provider.resolve(video_id)
    except providers.ProviderBusy as exc:
        raise StockBusy(wait=exc.retry_after) from exc
    except providers.ProviderError as exc:
        raise StockUnavailable() from exc


def import_video(owner, provider_name: str, video_id: str) -> tuple[Asset, bool]:
    """The owner's asset for a stock clip, downloaded on first use; returns (asset, created)."""
    provider = video_providers.provider_for(provider_name)
    if provider is None:
        raise StockNotConfigured()
    if not provider.valid_id(video_id):
        raise serializers.ValidationError({"id": ["Not a valid video id for this provider."]})

    existing = Asset.objects.filter(
        owner=owner, kind=Asset.Kind.VIDEO, meta__provider=provider.name, meta__video_id=video_id
    ).first()
    if existing:
        return existing, False

    resolved = _resolved(provider_name, video_id)
    with TemporaryDirectory(prefix="doory-clip-") as folder:
        path = Path(folder) / "clip"
        try:
            providers.download_file(
                resolved.download_url,
                hosts=provider.video_hosts,
                max_bytes=settings.MAX_VIDEO_UPLOAD_BYTES,
                target=path,
            )
        except providers.PhotoTooLarge as exc:
            raise FileTooLarge("The clip is too large.") from exc
        except providers.ProviderError as exc:
            raise StockUnavailable() from exc
        video = resolved.video
        asset = create_video_asset(
            owner,
            path,
            name=clean_name(f"Video by {video.author}" if video.author else f"{provider.label} video"),
            meta={
                "provider": provider.name,
                "video_id": video_id,
                "attribution": {
                    "provider": provider.name,
                    "author": video.author,
                    "author_url": video.author_url,
                    "source_url": video.source_url,
                },
            },
        )
    return asset, True


class VideoStockInfoView(APIView):
    @extend_schema(responses={200: dict}, tags=["stock"])
    def get(self, request):
        return Response(info())


class VideoStockSearchView(APIView):
    def get_throttles(self):
        return [*super().get_throttles(), StockRateThrottle()]

    @extend_schema(parameters=[VideoSearchSerializer], responses={200: dict}, tags=["stock"])
    def get(self, request):
        params = VideoSearchSerializer(data=request.query_params)
        params.is_valid(raise_exception=True)
        data = params.validated_data
        return Response(
            search(
                data.get("provider"),
                data.get("q", ""),
                data.get("orientation", "all"),
                data.get("page", 1),
                data.get("per_page", DEFAULT_PER_PAGE),
                data.get("lang", ""),
                data.get("cursor"),
            )
        )


class VideoStockPreviewView(APIView):
    """The clip's small file, relayed from the provider's CDN."""

    def get_throttles(self):
        return [*super().get_throttles(), StockPreviewRateThrottle()]

    @extend_schema(responses={(200, "video/mp4"): bytes}, tags=["stock"])
    def get(self, request, provider_name: str, video_id: str):
        if not settings.VIDEO_ASSETS_ENABLED:
            raise NotFound()
        provider = video_providers.provider_for(provider_name)
        if provider is None:
            raise NotFound()
        resolved = _resolved(provider_name, video_id)
        with TemporaryDirectory(prefix="doory-preview-") as folder:
            path = Path(folder) / "clip"
            try:
                providers.download_file(
                    resolved.preview_url,
                    hosts=provider.video_hosts,
                    max_bytes=PREVIEW_MAX_BYTES,
                    target=path,
                )
            except providers.PhotoTooLarge as exc:
                raise FileTooLarge("The preview is too large.") from exc
            except providers.ProviderError as exc:
                raise StockUnavailable() from exc
            data = path.read_bytes()
        mime = mimetypes.guess_type(resolved.preview_url)[0] or "video/mp4"
        response = HttpResponse(data, content_type=mime)
        response["Cache-Control"] = f"private, max-age={PREVIEW_BROWSER_CACHE_SECONDS}"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class VideoStockImportView(APIView):
    def get_throttles(self):
        return [*super().get_throttles(), UploadRateThrottle()]

    @extend_schema(
        request=VideoImportSerializer, responses={200: AssetSerializer, 201: AssetSerializer}, tags=["stock"]
    )
    def post(self, request):
        body = VideoImportSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        asset, created = import_video(
            request.user, body.validated_data["provider"], body.validated_data["id"]
        )
        return Response(
            AssetSerializer(asset).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
        )
