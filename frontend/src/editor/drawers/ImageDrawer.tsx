import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AssetRef } from '@/types/adapter'
import type { Asset } from '@/types/api'
import { I } from '../chrome/icons'
import { useEditor, useEditorState, useEditorStateShallow } from '../context'
import { imageFilesFrom } from '../engine/files'
import { useAsyncList } from '../hooks/useAsyncList'
import { useResolvedSrc } from '../hooks/useResolvedSrc'
import type { PanelProps } from '../panels/registry'
import { t } from '../strings'
import { loadable } from '../ui/loadable'
import { Skeleton } from '../ui/Skeleton'
import ed from '../chrome/ed.module.css'
import styles from './Drawers.module.css'
import { uploadToLibrary } from './uploads'

function toRef(a: Asset): AssetRef {
  return { id: a.id, url: a.url, thumbUrl: a.thumb_url, width: a.width, height: a.height, name: a.name, kind: a.kind }
}

function Thumb({ asset, onPlace, onDelete }: { asset: AssetRef; onPlace: () => void; onDelete?: () => void }) {
  const url = useResolvedSrc(asset.thumbUrl || asset.url)
  return (
    <div className={styles.thumbRow}>
      <button type="button" className={ed.uploadedThumb} data-testid="uploaded-thumb" onClick={onPlace}>
        {url ? <img src={url} alt="" draggable={false} /> : <Skeleton width={40} height={40} radius={5} />}
        <span className={ed.uploadedName}>{asset.name}</span>
      </button>
      {onDelete ? (
        <button type="button" className={styles.thumbDelete} aria-label={t.imageDrawer.remove(asset.name)} title={t.imageDrawer.remove(asset.name)} onClick={onDelete}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

/** Uploads tab: the "Upload photo" zone and the list of images, plus drag and drop and delete. */
function UploadsTab({ close }: PanelProps) {
  const editor = useEditor()
  const session = useEditorStateShallow((s) => s.uploads)
  const uploading = useEditorState((s) => s.uploading)
  const library = useAsyncList<Asset>((page) => editor.adapter.services.assets.list({ page, page_size: 20 }), 'library')
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const [over, setOver] = useState(false)
  const [failed, setFailed] = useState(false)

  const sessionIds = new Set(session.map((u) => u.id))
  const images: AssetRef[] = [...session, ...library.items.filter((a) => !sessionIds.has(a.id)).map(toRef)].filter((a) => !removed.has(a.id))

  const place = (asset: AssetRef): void => {
    void editor.insert.imageFromAsset(asset)
    close()
  }
  const remove = async (asset: AssetRef): Promise<void> => {
    setFailed(false)
    try {
      await editor.adapter.services.assets.remove(asset.id)
      setRemoved((cur) => new Set(cur).add(asset.id))
      editor.toast(t.imageDrawer.removed, 'info')
    } catch {
      setFailed(true)
    }
  }
  const onDrop = (e: React.DragEvent): void => {
    setOver(false)
    const files = imageFilesFrom(e.dataTransfer)
    if (files.length === 0) return
    e.preventDefault()
    void uploadToLibrary(editor, files)
  }

  return (
    <>
      <p className={ed.sectionTitle}>{t.drawers.uploadPhoto}</p>
      <button
        type="button"
        className={ed.uploadZone}
        data-testid="upload-zone"
        data-over={over || undefined}
        onClick={() => void editor.insert.pickAndUpload()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {I.upload}
        <div>{t.drawers.clickToUpload}</div>
        <small>{t.imageDrawer.dropHere}</small>
      </button>
      {uploading > 0 ? (
        <div className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {t.imageDrawer.uploading(uploading)}
        </div>
      ) : null}
      {failed ? (
        <p className={styles.error} role="alert">
          {t.imageDrawer.removeFailed}
        </p>
      ) : null}
      {images.length > 0 ? (
        <>
          <p className={ed.sectionTitle} style={{ marginTop: 16 }}>
            {t.drawers.yourImages}
          </p>
          {images.map((img) => (
            <Thumb key={img.id} asset={img} onPlace={() => place(img)} onDelete={library.items.some((a) => a.id === img.id) || sessionIds.has(img.id) ? () => void remove(img) : undefined} />
          ))}
        </>
      ) : null}
      {library.error && images.length === 0 ? (
        <p className={styles.error} role="alert">
          {t.imageDrawer.libraryFailed}
        </p>
      ) : null}
      {library.hasMore && library.items.length > 0 ? (
        <button type="button" className={`${ed.btn} ${ed.ghost}`} style={{ width: '100%', marginTop: 8 }} onClick={library.loadMore} disabled={library.loading}>
          {t.imageDrawer.loadMore}
        </button>
      ) : null}
      {!library.loading && !library.error && images.length === 0 ? <p className={styles.note}>{t.imageDrawer.noImages}</p> : null}
    </>
  )
}

const StockTab = loadable(() => import('./StockTab').then((m) => m.StockTab))
const VideoTab = loadable(() => import('./VideoTab').then((m) => m.VideoTab))

/** Image drawer: upload photo, plus a stock-photo tab and a videos tab when the server offers them. */
export function ImageDrawer(props: PanelProps) {
  const editor = useEditor()
  const hasStock = editor.adapter.services.stock !== null
  const hasVideo = editor.adapter.services.videoStock !== null
  const [tab, setTab] = useState<'uploads' | 'stock' | 'videos'>('uploads')
  return (
    <>
      {hasStock || hasVideo ? (
        <div className={styles.tabs} role="tablist" aria-label={t.imageDrawer.tabs}>
          <button type="button" role="tab" className={styles.tab} aria-selected={tab === 'uploads'} data-testid="image-tab-uploads" onClick={() => setTab('uploads')}>
            {t.imageDrawer.uploads}
          </button>
          {hasStock ? (
            <button type="button" role="tab" className={styles.tab} aria-selected={tab === 'stock'} data-testid="image-tab-stock" onClick={() => setTab('stock')}>
              {t.imageDrawer.stock}
            </button>
          ) : null}
          {hasVideo ? (
            <button type="button" role="tab" className={styles.tab} aria-selected={tab === 'videos'} data-testid="image-tab-videos" onClick={() => setTab('videos')}>
              {t.imageDrawer.videos}
            </button>
          ) : null}
        </div>
      ) : null}
      {tab === 'videos' && hasVideo ? <VideoTab {...props} /> : tab === 'stock' && hasStock ? <StockTab {...props} /> : <UploadsTab {...props} />}
    </>
  )
}
