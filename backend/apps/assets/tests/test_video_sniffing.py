"""Recognising a video file: the container comes from the bytes, never from the name."""

from pathlib import Path

import pytest

from apps.assets import video
from apps.assets.exceptions import InvalidFile

from .audio_helpers import m4a_bytes
from .video_helpers import clip_bytes, requires_ffmpeg

ISOBMFF = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
EBML = b"\x1a\x45\xdf\xa3" + b"\x00" * 24


class TestContainers:
    def test_an_iso_base_media_file_is_a_clip(self):
        assert video.container_of(ISOBMFF) == "mp4"
        assert video.looks_like_video(ISOBMFF)

    def test_a_quicktime_file_is_told_apart(self):
        assert video.container_of(b"\x00\x00\x00\x18ftypqt  \x00\x00\x02\x00qt  ") == "mov"

    def test_a_matroska_file_is_a_clip(self):
        assert video.container_of(EBML) == "mkv"
        assert video.looks_like_video(EBML)

    def test_an_image_in_an_iso_container_is_not_a_clip(self):
        head = b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avifmif1"
        assert video.container_of(head) is None
        assert not video.looks_like_video(head)

    @pytest.mark.parametrize(
        "head",
        [
            b"",
            b"RIFF\x24\x00\x00\x00WAVEfmt ",
            b"ID3\x03\x00\x00\x00\x00\x00\x00",
            b"\xff\xfb\x90\x44",
            b"OggS\x00\x02\x00\x00\x00\x00\x00\x00",
            b"\x89PNG\r\n\x1a\n",
            b"MZ\x90\x00\x03\x00\x00\x00",
        ],
    )
    def test_other_files_are_not_clips(self, head):
        assert not video.looks_like_video(head)


@requires_ffmpeg
class TestProbe:
    def test_it_reads_the_clips_facts(self, tmp_path: Path):
        path = tmp_path / "clip.mp4"
        path.write_bytes(clip_bytes(seconds=1.0, size=(320, 240), fps=25))
        info = video.probe(path)
        assert (info.width, info.height) == (320, 240)
        assert (info.mime, info.ext) == ("video/mp4", "mp4")
        assert 900 <= info.duration_ms <= 1100
        assert info.fps == 25
        assert not info.has_audio

    def test_a_clip_with_sound_says_so(self, tmp_path: Path):
        path = tmp_path / "clip.mp4"
        path.write_bytes(clip_bytes(seconds=0.5, sound=True))
        assert video.probe(path).has_audio

    def test_an_audio_only_container_holds_no_video(self, tmp_path: Path):
        path = tmp_path / "sound.m4a"
        path.write_bytes(m4a_bytes())
        with pytest.raises(video.NoVideoTrack):
            video.probe(path)

    def test_a_truncated_clip_cannot_be_read(self, tmp_path: Path):
        path = tmp_path / "cut.mp4"
        path.write_bytes(clip_bytes()[:200])
        with pytest.raises(InvalidFile):
            video.probe(path)

    def test_a_text_file_is_not_a_clip(self, tmp_path: Path):
        path = tmp_path / "note.mp4"
        path.write_bytes(b"this is not a video" * 20)
        with pytest.raises(InvalidFile):
            video.probe(path)


@requires_ffmpeg
class TestPosterAndSound:
    def test_the_poster_is_a_webp_frame(self, tmp_path: Path):
        path = tmp_path / "clip.mp4"
        path.write_bytes(clip_bytes(seconds=1.0, size=(320, 240)))
        info = video.probe(path)
        poster = video.extract_poster(path, info.duration_ms, (info.width, info.height))
        assert poster and poster[:4] == b"RIFF" and poster[8:12] == b"WEBP"

    def test_the_sound_is_a_clip_of_its_own(self, tmp_path: Path):
        path = tmp_path / "clip.mp4"
        path.write_bytes(clip_bytes(seconds=0.5, sound=True))
        sound = video.extract_audio(path)
        assert sound and sound[4:8] == b"ftyp"

    def test_a_silent_clip_has_no_sound(self, tmp_path: Path):
        path = tmp_path / "clip.mp4"
        path.write_bytes(clip_bytes(seconds=0.5))
        assert video.extract_audio(path) is None
