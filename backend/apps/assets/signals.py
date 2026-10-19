from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Asset
from .storage import delete_files_on_commit


@receiver(post_delete, sender=Asset, dispatch_uid="assets.asset_delete_files")
def delete_asset_files(sender, instance: Asset, **kwargs) -> None:
    delete_files_on_commit(instance.file.storage, [instance.file.name, instance.thumbnail.name])


@receiver(post_delete, sender=Asset, dispatch_uid="assets.asset_delete_companion_sound")
def delete_companion_sound(sender, instance: Asset, **kwargs) -> None:
    """A clip's sound is an asset of its own; deleting the clip takes the sound with it."""
    if instance.kind != Asset.Kind.VIDEO:
        return
    info = instance.meta.get("video") if isinstance(instance.meta, dict) else None
    companion_id = info.get("audio_asset_id") if isinstance(info, dict) else None
    if not companion_id:
        return
    Asset.objects.filter(pk=companion_id, owner_id=instance.owner_id).delete()
