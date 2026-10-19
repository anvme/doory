/**
 * The Videos tab: the clips the user uploaded and the stock clips (Pexels, Pixabay). A clip is placed on the
 * page as a picture of its poster frame; the clip itself plays in the preview and is drawn by the export.
 */
import { useEffect, useId, useState } from 'react'
import { isApiError } from '@/lib/api'
import type { AssetRef } from '@/types/adapter'
import type { Asset, StockVideo, StockVideoInfo } from '@/types/api'
import { useEditor } from '../context'
import { useAsyncList } from '../hooks/useAsyncList'
import { useDebounced } from '../hooks/useDebounced'
import type { PanelProps } from '../panels/registry'
import { t } from '../strings'
import { Skeleton } from '../ui/Skeleton'
import styles from './Drawers.module.css'

const ALL = 'all'

function toRef(asset: Asset): AssetRef {
  return {
    id: asset.id,
    url: asset.url,
    thumbUrl: asset.thumb_url,
    width: asset.width,
    height: asset.height,
    name: asset.name,
    kind: asset.kind,
    video: asset.video
      ? {
          durationMs: asset.video.duration_ms,
          fps: asset.video.fps,
          hasAudio: asset.video.has_audio,
          audioAssetId: asset.video.audio_asset_id,
          audioUrl: asset.video.audio_url,
        }
      : null,
  }
}

/** `0:12`: how long a clip reads on its chip. */
function clipLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function VideoTab({ close }: PanelProps) {
  const editor = useEditor()
  const stock = editor.adapter.services.videoStock ?? null
  const [info, setInfo] = useState<StockVideoInfo | null>(null)
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [orientation, setOrientation] = useState(ALL)
  const [importing, setImporting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const q = useDebounced(query.trim(), 300)
  const searchId = useId()
  const orientationId = useId()

  useEffect(() => {
    if (!stock) return
    let live = true
    stock.info().then(
      (found) => {
        if (!live) return
        setInfo(found)
        setSource(found.providers[0]?.name ?? '')
      },
      () => live && setInfo({ configured: false, providers: [], orientations: [] }),
    )
    return () => {
      live = false
    }
  }, [stock])

  const library = useAsyncList<Asset>((page) => editor.adapter.services.assets.list({ kind: 'video', page, page_size: 20 }), 'videos')
  const clips = useAsyncList<StockVideo>(
    async (page) => {
      if (!stock) throw new Error(t.imageDrawer.videosOff)
      const res = await stock.search(q || 'nature', { provider: source || undefined, orientation, page })
      return { count: res.total, next: res.next_page === null ? null : String(res.next_page), previous: null, results: res.results }
    },
    `${source}\u0000${q}\u0000${orientation}`,
    stock !== null && info?.configured === true,
  )

  const place = (ref: AssetRef): void => {
    void editor.insert.videoFromAsset(ref)
    close()
  }

  const add = async (video: StockVideo): Promise<void> => {
    if (!stock) return
    setImporting(video.id)
    setError(null)
    try {
      place(await stock.importVideo(video))
    } catch (err) {
      setError(isApiError(err) && err.isRateLimited ? t.imageDrawer.stockBusy(video.provider, err.retryAfter) : t.imageDrawer.importVideoFailed)
    } finally {
      setImporting(null)
    }
  }

  const labels = new Map((info?.providers ?? []).map((p) => [p.name, p.label]))
  const label = (name: string): string => labels.get(name) ?? name

  return (
    <>
      {library.items.length > 0 ? (
        <>
          <p className={styles.note}>{t.imageDrawer.yourVideos}</p>
          {library.items.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={styles.photo}
              data-testid="video-mine"
              onClick={() => place(toRef(asset))}
              title={asset.name}
            >
              <img src={asset.thumb_url} alt="" loading="lazy" draggable={false} />
              {asset.video?.duration_ms ? <span className={styles.badge}>{clipLength(asset.video.duration_ms)}</span> : null}
            </button>
          ))}
        </>
      ) : null}
      {info?.configured ? (
        <>
          {info.providers.length > 1 ? (
            <div className={styles.sources} role="tablist" aria-label={t.imageDrawer.sources}>
              {info.providers.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  role="tab"
                  className={styles.source}
                  aria-selected={source === provider.name}
                  data-testid={`video-source-${provider.name}`}
                  onClick={() => setSource(provider.name)}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          ) : null}
          <label className={styles.search} htmlFor={searchId}>
            {t.imageDrawer.searchVideos}
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.imageDrawer.searchVideos}
              aria-label={t.imageDrawer.searchVideos}
              data-testid="video-search"
            />
          </label>
          {info.orientations.length > 1 ? (
            <label className={styles.search} htmlFor={orientationId}>
              {t.imageDrawer.orientation}
              <select
                id={orientationId}
                value={orientation}
                onChange={(e) => setOrientation(e.target.value)}
                aria-label={t.imageDrawer.orientation}
                data-testid="video-orientation"
              >
                {info.orientations.map((value) => (
                  <option key={value} value={value}>
                    {value === ALL ? t.imageDrawer.all : value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {clips.loading && clips.items.length === 0 ? (
            <div className={styles.photos} aria-busy="true">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} height="auto" radius={8} style={{ aspectRatio: '4 / 3' }} />
              ))}
            </div>
          ) : null}
          <div className={styles.photos}>
            {clips.items.map((video) => (
              <button
                key={`${video.provider}:${video.id}`}
                type="button"
                className={styles.photo}
                data-testid="video-stock"
                aria-label={t.imageDrawer.addVideo(video.author, label(video.provider))}
                title={t.imageDrawer.videoByOn(video.author, label(video.provider))}
                disabled={importing !== null}
                onClick={() => void add(video)}
              >
                <img src={video.thumb_url} alt="" loading="lazy" draggable={false} />
                <span className={styles.badge}>{clipLength(video.duration_ms)}</span>
                <span className={styles.credit}>{t.imageDrawer.videoByOn(video.author, label(video.provider))}</span>
              </button>
            ))}
          </div>
          {!clips.loading && !clips.error && clips.items.length === 0 ? <p className={styles.note}>{t.imageDrawer.videoEmpty}</p> : null}
          {info.providers.length > 0 ? (
            <p className={styles.attribution} data-testid="video-attribution">
              {info.providers.map((provider, index) => (
                <span key={provider.name}>
                  {index > 0 ? ' · ' : null}
                  <a href={provider.url} target="_blank" rel="noopener noreferrer">
                    {provider.attribution}
                  </a>
                </span>
              ))}
            </p>
          ) : null}
        </>
      ) : stock ? (
        <p className={styles.note}>{t.imageDrawer.videosOff}</p>
      ) : null}
      {importing ? (
        <div className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {t.imageDrawer.importingVideo}
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
