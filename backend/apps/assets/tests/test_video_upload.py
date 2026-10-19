"""Uploading a video clip through POST /assets/."""

from pathlib import Path

import pytest
from django.core.files.storage import default_storage

from apps.assets.models import Asset

from .audio_helpers import m4a_bytes, webm_bytes
from .helpers import upload
from .video_helpers import clip_bytes, requires_ffmpeg

URL = "/api/v1/assets/"
#: A file that claims to be an MP4 without being one: enough to be routed to the clip pipeline.
FAKE_MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 100


def post(api, data, filename="clip.mp4", **extra):
    return api.post(
        URL, {"file": upload(data, filename, "application/octet-stream"), **extra}, format="multipart"
    )


@pytest.fixture
def clips_on(settings):
    settings.VIDEO_ASSETS_ENABLED = True
    return settings


@requires_ffmpeg
@pytest.mark.django_db
class TestAccepted:
    def test_the_clip_becomes_a_video_asset(self, api, clips_on):
        res = post(api, clip_bytes(seconds=1.0, size=(320, 240)), "Holiday.mp4")
        assert res.status_code == 201, res.content
        body = res.json()
        assert body["kind"] == "video"
        assert body["mime"] == "video/mp4"
        assert (body["width"], body["height"]) == (320, 240)
        assert body["url"].endswith(".mp4")
        assert body["duration_ms"] == body["video"]["duration_ms"]
        assert body["video"]["fps"] == 25
        assert body["video"]["codec"] == "h264"
        assert body["video"]["has_audio"] is False
        assert body["video"]["width"] == 320

    def test_the_clip_is_stored_as_it_came(self, api, clips_on):
        data = clip_bytes()
        res = post(api, data)
        asset = Asset.objects.get(pk=res.json()["id"])
        assert Path(default_storage.path(asset.file.name)).read_bytes() == data

    def test_the_poster_is_the_thumbnail(self, api, clips_on):
        res = post(api, clip_bytes())
        asset = Asset.objects.get(pk=res.json()["id"])
        poster = Path(default_storage.path(asset.thumbnail.name)).read_bytes()
        assert poster[:4] == b"RIFF" and poster[8:12] == b"WEBP"
        assert res.json()["thumb_url"].endswith(".webp")

    def test_the_type_comes_from_the_content_not_from_the_client(self, api, clips_on):
        res = post(api, clip_bytes(), "photo.png")
        assert res.status_code == 201 and res.json()["kind"] == "video"

    def test_the_name_and_tags_work_as_for_images(self, api, clips_on):
        res = post(api, clip_bytes(), "x.mp4", name="  Summer  ", tags=["Trip", " trip "])
        assert (res.json()["name"], res.json()["tags"]) == ("Summer", ["trip"])

    def test_a_clip_with_sound_gets_its_own_audio_asset(self, api, clips_on):
        res = post(api, clip_bytes(sound=True))
        assert res.status_code == 201, res.content
        companion_id = res.json()["video"]["audio_asset_id"]
        companion = Asset.objects.get(pk=companion_id)
        assert companion.kind == Asset.Kind.AUDIO
        assert companion.name == "clip.mp4 (audio)"
        assert companion.mime == "audio/mp4"
        assert companion.size > 0

    def test_the_clip_and_its_sound_both_count(self, api, clips_on):
        post(api, clip_bytes(sound=True))
        clip = Asset.objects.get(kind=Asset.Kind.VIDEO)
        sound = Asset.objects.get(kind=Asset.Kind.AUDIO)
        used = api.get(URL + "usage/").json()["used_bytes"]
        assert used == clip.size + sound.size

    def test_the_sound_is_left_out_of_the_default_list(self, api, clips_on):
        post(api, clip_bytes(sound=True))
        body = api.get(URL).json()
        assert [a["kind"] for a in body["results"]] == [] and body["count"] == 0


@pytest.mark.django_db
class TestRejected:
    def test_video_uploads_are_off_by_default(self, api):
        res = post(api, m4a_bytes((b"soun", b"vide")))
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "video_disabled"
        assert Asset.objects.count() == 0

    @requires_ffmpeg
    def test_a_clip_over_the_limit_is_refused(self, api, settings, clips_on):
        settings.MAX_VIDEO_UPLOAD_BYTES = 100
        res = post(api, clip_bytes())
        assert res.status_code == 413 and res.json()["error"]["code"] == "file_too_large"

    @requires_ffmpeg
    def test_a_file_that_only_claims_to_be_a_clip_is_refused(self, api, clips_on):
        res = post(api, FAKE_MP4)
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_file"

    @requires_ffmpeg
    def test_the_quota_counts_the_sound_too(self, api, settings, clips_on):
        data = clip_bytes(sound=True)
        post(api, data)
        sound = Asset.objects.get(kind=Asset.Kind.AUDIO).size
        Asset.objects.all().delete()
        settings.USER_STORAGE_QUOTA_BYTES = len(data) + sound - 1
        res = post(api, data)
        assert res.status_code == 413 and res.json()["error"]["code"] == "quota_exceeded"


@requires_ffmpeg
@pytest.mark.django_db
class TestFilesThatOnlyClaimToBeVideo:
    def test_a_broken_clip_is_refused(self, api, clips_on):
        res = post(api, webm_bytes((1, 2)), "movie.webm")
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_file"
        assert Asset.objects.count() == 0

    def test_a_file_with_a_video_track_is_not_audio(self, api, clips_on):
        res = post(api, m4a_bytes((b"soun", b"vide"), brand=b"mp42"), "movie.mp4")
        assert res.status_code == 201 and res.json()["kind"] == "video"

    def test_the_error_names_the_reason(self, api, clips_on):
        res = post(api, webm_bytes((1, 2)), "movie.webm")
        assert "video" in res.json()["error"]["message"]


@requires_ffmpeg
@pytest.mark.django_db
class TestListingAndDeleting:
    def test_clips_are_left_out_of_the_default_list(self, api, clips_on):
        post(api, clip_bytes(), "a.mp4")
        body = api.get(URL).json()
        assert [a["kind"] for a in body["results"]] == [] and body["count"] == 0

    def test_kind_video_lists_only_clips(self, api, clips_on):
        mine = post(api, clip_bytes(), "mine.mp4").json()
        body = api.get(URL, {"kind": "video"}).json()
        assert [a["id"] for a in body["results"]] == [mine["id"]] and body["count"] == 1

    def test_deleting_a_clip_deletes_its_sound(self, api, django_capture_on_commit_callbacks, clips_on):
        asset = post(api, clip_bytes(sound=True)).json()
        companion = Asset.objects.get(pk=asset["video"]["audio_asset_id"])
        stored = companion.file.name
        with django_capture_on_commit_callbacks(execute=True):
            assert api.delete(f"{URL}{asset['id']}/").status_code == 204
        assert not Asset.objects.filter(pk=companion.pk).exists()
        assert not default_storage.exists(stored)
