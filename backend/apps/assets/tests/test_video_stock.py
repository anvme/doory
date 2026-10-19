"""Stock video: searching Pexels and Pixabay, and importing a clip."""

import pytest

from apps.assets import providers
from apps.assets.models import Asset

from .test_stock import FakeNetwork, FakeResponse
from .video_helpers import clip_bytes, requires_ffmpeg

SEARCH = "/api/v1/stock/videos/"
INFO = "/api/v1/stock/videos/info/"
IMPORT = "/api/v1/stock/videos/import/"
PEXELS_API = "https://api.pexels.com/v1/videos/search"
PIXABAY_API = "https://pixabay.com/api/videos/"


def pexels_video(video_id=1234, **overrides):
    item = {
        "id": video_id,
        "width": 1920,
        "height": 1080,
        "duration": 12,
        "image": f"https://images.pexels.com/videos/{video_id}/poster.jpg",
        "user": {"name": "Jo Doe", "url": "https://www.pexels.com/@jodoe"},
        "url": f"https://www.pexels.com/video/{video_id}/",
        "video_files": [
            {
                "id": "1",
                "quality": "sd",
                "file_type": "video/mp4",
                "width": 640,
                "height": 360,
                "link": f"https://videos.pexels.com/video-files/{video_id}/{video_id}-sd.mp4",
            },
            {
                "id": "2",
                "quality": "hd",
                "file_type": "video/mp4",
                "width": 1920,
                "height": 1080,
                "link": f"https://videos.pexels.com/video-files/{video_id}/{video_id}-hd.mp4",
            },
        ],
    }
    item.update(overrides)
    return item


def pixabay_video(video_id=4321, **overrides):
    item = {
        "id": video_id,
        "duration": 8,
        "user": "sam_shooter",
        "user_id": 99,
        "pageURL": f"https://pixabay.com/videos/{video_id}/",
        "image": f"https://cdn.pixabay.com/video/{video_id}/poster.jpg",
        "videos": {
            "tiny": {
                "url": f"https://cdn.pixabay.com/video/{video_id}/tiny.mp4",
                "width": 320,
                "height": 180,
            },
            "large": {
                "url": f"https://cdn.pixabay.com/video/{video_id}/large.mp4",
                "width": 1920,
                "height": 1080,
            },
        },
    }
    item.update(overrides)
    return item


@pytest.fixture
def net(monkeypatch):
    network = FakeNetwork()
    monkeypatch.setattr(providers, "http_get", network)
    return network


@pytest.fixture
def keys(settings):
    settings.VIDEO_ASSETS_ENABLED = True
    settings.PEXELS_API_KEY = ""
    settings.PIXABAY_API_KEY = ""
    settings.PEXELS_VIDEO_API_KEY = "pexels-video-secret"
    settings.PIXABAY_VIDEO_API_KEY = ""


@pytest.mark.django_db
class TestInfo:
    def test_the_tab_is_hidden_without_a_key(self, api, settings):
        settings.VIDEO_ASSETS_ENABLED = True
        settings.PEXELS_API_KEY = settings.PIXABAY_API_KEY = ""
        settings.PEXELS_VIDEO_API_KEY = settings.PIXABAY_VIDEO_API_KEY = ""
        body = api.get(INFO).json()
        assert body["configured"] is False and body["providers"] == []

    def test_the_tab_is_hidden_while_video_is_off(self, api, settings):
        settings.VIDEO_ASSETS_ENABLED = False
        settings.PEXELS_VIDEO_API_KEY = "pexels-video-secret"
        assert api.get(INFO).json()["configured"] is False

    def test_the_providers_are_listed(self, api, keys):
        body = api.get(INFO).json()
        assert body["configured"] is True
        assert [p["name"] for p in body["providers"]] == ["pexels_video"]
        assert body["providers"][0]["attribution"] == "Videos provided by Pexels"
        assert "landscape" in body["orientations"]


@pytest.mark.django_db
class TestSearch:
    def test_not_configured(self, api, settings, net):
        settings.VIDEO_ASSETS_ENABLED = True
        settings.PEXELS_API_KEY = settings.PIXABAY_API_KEY = ""
        settings.PEXELS_VIDEO_API_KEY = settings.PIXABAY_VIDEO_API_KEY = ""
        assert api.get(SEARCH, {"q": "rain"}).json()["configured"] is False
        assert net.calls == []

    def test_pexels_maps_the_clips_and_sends_the_key_in_a_header(self, api, keys, net):
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 40, "videos": [pexels_video()]}))
        res = api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        assert res.status_code == 200
        body = res.json()
        assert body["total"] == 40 and body["next_page"] == 2
        clip = body["results"][0]
        assert clip["id"] == "1234" and clip["author"] == "Jo Doe"
        assert clip["duration_ms"] == 12000 and clip["width"] == 1920
        assert clip["thumb_url"] == "https://images.pexels.com/videos/1234/poster.jpg"
        assert "videos.pexels.com" in clip["preview_url"]
        assert "download_url" not in clip  # the browser never gets the file
        assert net.calls[0]["headers"]["Authorization"] == "pexels-video-secret"
        assert net.calls[0]["params"]["query"] == "rain"

    def test_the_orientation_is_sent_to_the_provider(self, api, keys, net):
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 0, "videos": []}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video", "orientation": "portrait"})
        assert net.calls[0]["params"]["orientation"] == "portrait"

    def test_pixabay_keeps_its_key_in_the_query(self, api, settings, net):
        settings.PIXABAY_VIDEO_API_KEY = "pixabay-video-secret"
        net.add(PIXABAY_API, FakeResponse(payload={"totalHits": 3, "hits": [pixabay_video()]}))
        res = api.get(SEARCH, {"q": "rain", "provider": "pixabay_video"})
        assert res.status_code == 200
        clip = res.json()["results"][0]
        assert clip["id"] == "4321" and clip["author"] == "sam_shooter"
        assert clip["duration_ms"] == 8000
        assert net.calls[0]["params"]["key"] == "pixabay-video-secret"

    def test_a_video_key_falls_back_to_the_photo_key(self, api, settings, net):
        settings.PEXELS_VIDEO_API_KEY = ""
        settings.PEXELS_API_KEY = "pexels-photo-secret"
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 0, "videos": []}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        assert net.calls[0]["headers"]["Authorization"] == "pexels-photo-secret"

    def test_a_file_on_another_host_is_dropped(self, api, keys, net):
        clip = pexels_video()
        clip["video_files"] = [
            {**clip["video_files"][0], "link": "https://evil.example/clip.mp4"},
            {**clip["video_files"][1], "link": "https://evil.example/clip-hd.mp4"},
        ]
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 1, "videos": [clip]}))
        assert api.get(SEARCH, {"q": "rain", "provider": "pexels_video"}).json()["results"] == []

    def test_a_provider_error_is_a_502(self, api, keys, net):
        net.add(PEXELS_API, FakeResponse(status=500))
        res = api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        assert res.status_code == 502

    def test_an_unknown_provider_is_a_400(self, api, keys):
        res = api.get(SEARCH, {"q": "rain", "provider": "coverr"})
        assert res.status_code == 400


@requires_ffmpeg
@pytest.mark.django_db
class TestImport:
    def test_the_clip_is_stored_with_its_credit(self, api, keys, net):
        data = clip_bytes(seconds=1.0)
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 1, "videos": [pexels_video()]}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        net.add(
            "https://videos.pexels.com/video-files/1234/1234-hd.mp4",
            FakeResponse(body=data, headers={"Content-Length": str(len(data))}),
        )
        res = api.post(IMPORT, {"provider": "pexels_video", "id": "1234"}, format="json")
        assert res.status_code == 201, res.content
        body = res.json()
        assert body["kind"] == "video" and body["mime"] == "video/mp4"
        assert body["attribution"]["provider"] == "pexels_video"
        assert body["attribution"]["author"] == "Jo Doe"
        assert body["video"]["duration_ms"] > 0
        asset = Asset.objects.get(pk=body["id"])
        assert asset.meta["provider"] == "pexels_video" and asset.meta["video_id"] == "1234"

    def test_the_same_clip_is_imported_once(self, api, keys, net):
        data = clip_bytes(seconds=1.0)
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 1, "videos": [pexels_video()]}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        net.add(
            "https://videos.pexels.com/video-files/1234/1234-hd.mp4",
            FakeResponse(body=data),
        )
        first = api.post(IMPORT, {"provider": "pexels_video", "id": "1234"}, format="json")
        second = api.post(IMPORT, {"provider": "pexels_video", "id": "1234"}, format="json")
        assert (first.status_code, second.status_code) == (201, 200)
        assert Asset.objects.filter(kind=Asset.Kind.VIDEO).count() == 1

    def test_a_clip_that_is_too_large_is_refused(self, api, settings, keys, net):
        settings.MAX_VIDEO_UPLOAD_BYTES = 10
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 1, "videos": [pexels_video()]}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        net.add(
            "https://videos.pexels.com/video-files/1234/1234-hd.mp4",
            FakeResponse(body=clip_bytes()),
        )
        res = api.post(IMPORT, {"provider": "pexels_video", "id": "1234"}, format="json")
        assert res.status_code == 413
        assert Asset.objects.count() == 0

    def test_the_preview_is_relayed_by_the_server(self, api, keys, net):
        data = clip_bytes(seconds=1.0)
        net.add(PEXELS_API, FakeResponse(payload={"total_results": 1, "videos": [pexels_video()]}))
        api.get(SEARCH, {"q": "rain", "provider": "pexels_video"})
        net.add(
            "https://videos.pexels.com/video-files/1234/1234-sd.mp4",
            FakeResponse(body=data, headers={"Content-Type": "video/mp4"}),
        )
        res = api.get("/api/v1/stock/videos/pexels_video/1234/preview/")
        assert res.status_code == 200
        assert res["Content-Type"].startswith("video/")
        assert res.content == data

    def test_a_clip_that_is_no_longer_known_is_a_502(self, api, keys, net):
        res = api.post(IMPORT, {"provider": "pexels_video", "id": "1234"}, format="json")
        assert res.status_code == 502
