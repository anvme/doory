/**
 * The sound of a clip, as a track the mixer can play.
 *
 * A clip with sound is heard like any other sound: it starts when the clip appears on the page and stops when
 * the clip does. The sound itself is a separate asset (the server took it out of the clip), so it is fetched
 * and mixed on its own. A clip that is sped up or slowed down is mixed at its normal speed: the picture and
 * the sound then drift apart, which the editor's clip panel shows.
 */
import type { AudioTrack, DocObject, DoryDocument } from '@/types/document'
import { clipWindow } from '../animation/videoClip'
import { videoOf, videoVolume, videoWindow } from '../engine/objects/video'

/** The track of a clip's sound, or null when the clip has no sound (or its sound is off). */
export function clipTrack(object: DocObject, pageId: string): AudioTrack | null {
  const video = videoOf(object)
  if (!video || !video.audioAssetId || !video.audioUrl) return null
  const { from, to } = videoWindow(video)
  if (to <= from) return null
  const { startMs } = clipWindow(object)
  return {
    id: `clip:${object.id}`,
    kind: 'upload',
    name: object.name || 'Clip sound',
    src: video.audioUrl,
    assetId: video.audioAssetId,
    scope: { type: 'page', pageId },
    startMs,
    durationMs: to - from,
    trimStartMs: from,
    trimEndMs: to,
    volume: videoVolume(video),
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: video.loop === true,
    muted: video.muted === true,
    duckUnderVoiceover: true,
  }
}

/** The sound of every clip of the design, as tracks. */
export function clipVoices(document: DoryDocument): AudioTrack[] {
  const tracks: AudioTrack[] = []
  for (const page of document.pages) {
    for (const object of page.objects) {
      const track = clipTrack(object, page.id)
      if (track) tracks.push(track)
    }
  }
  return tracks
}
