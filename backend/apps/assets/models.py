from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


def asset_file_path(instance, filename):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    return f"assets/{instance.owner_id}/{instance.id}.{ext}"


def asset_thumb_path(instance, filename):
    return f"assets/{instance.owner_id}/thumbs/{instance.id}.webp"


class Asset(BaseModel):
    class Kind(models.TextChoices):
        IMAGE = "image", "Image"
        SVG = "svg", "SVG"
        AUDIO = "audio", "Audio"
        VIDEO = "video", "Video"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="assets")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.IMAGE)
    name = models.CharField(max_length=255, blank=True)
    file = models.FileField(upload_to=asset_file_path)
    thumbnail = models.ImageField(upload_to=asset_thumb_path, blank=True)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    size = models.PositiveBigIntegerField(default=0)
    mime = models.CharField(max_length=64)
    tags = models.JSONField(default=list, blank=True)
    meta = models.JSONField(default=dict, blank=True)  # e.g. stock-photo attribution

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["owner", "-created_at"])]

    def __str__(self):
        return self.name or str(self.id)


#: The kinds that are not pictures: they cannot be placed on a page, used as a logo or sent to a model.
NON_PICTURE_KINDS = (Asset.Kind.AUDIO, Asset.Kind.VIDEO)
