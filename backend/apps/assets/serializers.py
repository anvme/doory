from django.core.files.storage import default_storage
from rest_framework import serializers

from .models import Asset
from .uploads import MAX_NAME_LENGTH, MAX_TAG_LENGTH, MAX_TAGS, clean_name, clean_tags


class AssetSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    thumb_url = serializers.SerializerMethodField()
    attribution = serializers.SerializerMethodField()
    duration_ms = serializers.SerializerMethodField()
    video = serializers.SerializerMethodField()

    class Meta:
        model = Asset
        fields = (
            "id",
            "kind",
            "name",
            "url",
            "thumb_url",
            "width",
            "height",
            "size",
            "mime",
            "tags",
            "attribution",
            "duration_ms",
            "video",
            "created_at",
        )
        read_only_fields = fields

    def get_url(self, obj: Asset) -> str:
        return obj.file.url

    def get_thumb_url(self, obj: Asset) -> str:
        if obj.thumbnail:
            return obj.thumbnail.url
        if obj.kind in (Asset.Kind.AUDIO, Asset.Kind.VIDEO):
            return ""  # the poster, never the file itself
        return obj.file.url

    def get_duration_ms(self, obj: Asset) -> int | None:
        meta = obj.meta if isinstance(obj.meta, dict) else {}
        for section in ("audio", "video"):
            info = meta.get(section)
            value = info.get("duration_ms") if isinstance(info, dict) else None
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    def get_video(self, obj: Asset) -> dict | None:
        """What the clip is (its length, frame rate and sound), or None for every other kind."""
        info = obj.meta.get("video") if isinstance(obj.meta, dict) else None
        if not isinstance(info, dict):
            return None
        return {
            "duration_ms": info.get("duration_ms"),
            "fps": info.get("fps"),
            "has_audio": bool(info.get("has_audio")),
            "codec": info.get("codec") or "",
            "width": obj.width,
            "height": obj.height,
            "audio_asset_id": info.get("audio_asset_id") or None,
            "audio_url": self._audio_url(info),
        }

    def _audio_url(self, info: dict) -> str | None:
        """Where the clip's sound can be fetched, when the clip has one."""
        path = info.get("audio_path")
        if not isinstance(path, str) or not path:
            return None
        try:
            return default_storage.url(path)
        except (NotImplementedError, ValueError):
            return None

    def get_attribution(self, obj: Asset) -> dict | None:
        attribution = obj.meta.get("attribution") if isinstance(obj.meta, dict) else None
        return attribution if isinstance(attribution, dict) else None


class TagsField(serializers.ListField):
    def __init__(self, **kwargs):
        kwargs.setdefault("child", serializers.CharField(max_length=MAX_TAG_LENGTH, allow_blank=True))
        kwargs.setdefault("max_length", MAX_TAGS)
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        return clean_tags(super().to_internal_value(data))


class AssetUploadSerializer(serializers.Serializer):
    file = serializers.FileField(allow_empty_file=False)
    name = serializers.CharField(max_length=MAX_NAME_LENGTH * 2, required=False, allow_blank=True)
    tags = TagsField(required=False)


class AssetUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=MAX_NAME_LENGTH * 2)
    tags = TagsField()

    def validate_name(self, value: str) -> str:
        name = clean_name(value, fallback="")
        if not name:
            raise serializers.ValidationError("The name cannot be empty.")
        return name


class AssetQuerySerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=Asset.Kind.choices, required=False)
    q = serializers.CharField(max_length=100, required=False, allow_blank=True)
    ordering = serializers.CharField(max_length=32, required=False, allow_blank=True)
