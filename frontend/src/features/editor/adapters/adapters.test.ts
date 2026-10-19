import { http as mswHttp, HttpResponse } from 'msw'
import { resetClientState } from '@/lib/api'
import { createBlankDocument } from '@/lib/document'
import { LocalRepository, createMemoryStore } from '@/lib/local'
import { server } from '@/test/msw'
import { captureFetch } from '@/test/utils'
import type { SaveInput } from '@/types/adapter'
import { createAccountAdapter } from './accountAdapter'
import { MigrationError, ReadOnlyDesignError } from './errors'
import { createGuestAdapter } from './guestAdapter'
import { createSharedAdapter } from './sharedAdapter'
import * as migration from './migrateLocalDesign'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function memoryRepo() {
  return new LocalRepository(async () => ({ store: createMemoryStore(), mode: 'memory' }))
}

const snapshot = (): SaveInput => ({ document: createBlankDocument(100, 100), title: 'Untitled design' })

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
  vi.stubGlobal('createImageBitmap', async () => ({ width: 640, height: 480, close: () => undefined }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('guest adapter', () => {
  function build(overrides: Partial<Parameters<typeof createGuestAdapter>[0]> = {}) {
    const repo = memoryRepo()
    const handlers = {
      ensureSignedIn: vi.fn(async () => true),
      onMigrated: vi.fn(),
      onMigrationError: vi.fn(),
      onMigrationStart: vi.fn(),
    }
    const adapter = createGuestAdapter({ localId: 'local-1', repository: repo, ...handlers, ...overrides })
    return { repo, adapter, handlers }
  }

  it('has no font library: guests are asked to sign up before they upload fonts', () => {
    const { adapter } = build()
    expect(adapter.services.fonts.mine).toBeUndefined()
    expect(adapter.services.fonts.provided).toBeUndefined()
  })

  it('saves to IndexedDB (via the repository) and resolves with a timestamp', async () => {
    const { repo, adapter } = build()
    const thumb = new Blob(['t'], { type: 'image/webp' })
    const result = await adapter.save({ ...snapshot(), thumbnail: thumb })
    expect(result.savedAt).toBeGreaterThan(0)
    expect(result.revision).toBeUndefined()
    const stored = await repo.getDesign('local-1')
    expect(stored?.title).toBe('Untitled design')
    expect(stored?.thumbnail).toBeDefined()
  })

  it('stores uploaded images locally and returns idb:// references with real dimensions', async () => {
    const { repo, adapter } = build()
    const ref = await adapter.uploadAsset(new File(['png-bytes'], 'cat.png', { type: 'image/png' }))
    expect(ref).toMatchObject({ url: expect.stringMatching(/^idb:\/\/[0-9a-f-]{36}$/), width: 640, height: 480, name: 'cat.png', kind: 'image' })
    expect(ref.thumbUrl).toBe(ref.url)
    expect(await repo.getAsset(ref.id)).not.toBeNull()
  })

  it('keeps SVG uploads as the svg kind using the viewBox for size', async () => {
    const { adapter } = build()
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="10" height="10"/></svg>'], 'logo.svg', { type: 'image/svg+xml' })
    const ref = await adapter.uploadAsset(svg)
    expect(ref).toMatchObject({ kind: 'svg', width: 120, height: 80 })
  })

  it('rejects non-images and oversized files before storing anything', async () => {
    const { repo, adapter } = build({ maxUploadBytes: 10 })
    await expect(adapter.uploadAsset(new File(['<html>'], 'evil.html', { type: 'text/html' }))).rejects.toThrow(/Only PNG/)
    await expect(adapter.uploadAsset(new File(['0123456789ABC'], 'big.png', { type: 'image/png' }))).rejects.toThrow(/larger than/)
    expect(await repo.listAssets()).toHaveLength(0)
  })

  it('resolves idb:// sources to object URLs and passes other sources through', async () => {
    const { repo, adapter } = build()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:abc', revokeObjectURL: () => undefined }))
    const asset = await repo.putAsset({ blob: new Blob(['x']), name: 'a', mime: 'image/png', width: 1, height: 1 })
    await expect(adapter.resolveSrc(`idb://${asset.id}`)).resolves.toBe('blob:abc')
    await expect(adapter.resolveSrc('/media/a.png')).resolves.toBe('/media/a.png')
    await expect(adapter.resolveSrc('https://x.test/a.png')).resolves.toBe('https://x.test/a.png')
    await expect(adapter.resolveSrc('idb://99999999-9999-4999-8999-999999999999')).rejects.toThrow(/no longer stored/)
  })

  it('exposes public catalogs but no brand, stock or versions', () => {
    const { adapter } = build()
    expect(adapter.services.brand).toBeNull()
    expect(adapter.services.stock).toBeNull()
    expect(adapter.services.versions).toBeNull()
    expect(typeof adapter.services.fonts.list).toBe('function')
    expect(adapter.exportPdf).toBeUndefined()
  })

  it('lists local uploads through services.assets', async () => {
    const { adapter } = build()
    await adapter.uploadAsset(new File(['a'], 'sunset.png', { type: 'image/png' }))
    await adapter.uploadAsset(new File(['b'], 'forest.png', { type: 'image/png' }))
    const page = await adapter.services.assets.list({ q: 'sun' })
    expect(page.results.map((a) => a.name)).toEqual(['sunset.png'])
    expect(page.results[0].url.startsWith('idb://')).toBe(true)
    await adapter.services.assets.remove(page.results[0].id)
    expect((await adapter.services.assets.list({})).count).toBe(1)
  })

  describe('requireAccount', () => {
    it('resolves false without touching storage when the user dismisses the auth modal', async () => {
      const migrate = vi.spyOn(migration, 'migrateLocalDesign')
      const { adapter, handlers } = build({ ensureSignedIn: vi.fn(async () => false) })
      await expect(adapter.requireAccount('save', async () => snapshot())).resolves.toBe(false)
      expect(migrate).not.toHaveBeenCalled()
      expect(handlers.onMigrated).not.toHaveBeenCalled()
    })

    it('migrates after sign-in, reports the new id and resolves true', async () => {
      vi.spyOn(migration, 'migrateLocalDesign').mockResolvedValue('design-42')
      const { adapter, handlers } = build()
      await expect(adapter.requireAccount('share', async () => snapshot())).resolves.toBe(true)
      expect(handlers.ensureSignedIn).toHaveBeenCalledWith('share')
      expect(handlers.onMigrationStart).toHaveBeenCalled()
      expect(handlers.onMigrated).toHaveBeenCalledWith('design-42')
    })

    it('resolves false on failure, reports the error and offers a working retry', async () => {
      const spy = vi.spyOn(migration, 'migrateLocalDesign').mockRejectedValueOnce(new MigrationError('Upload failed', 'assets'))
      const { adapter, handlers } = build()
      await expect(adapter.requireAccount('save', async () => snapshot())).resolves.toBe(false)
      expect(handlers.onMigrated).not.toHaveBeenCalled()
      const [error, retry] = handlers.onMigrationError.mock.calls[0] as [Error, () => Promise<boolean>]
      expect(error.message).toBe('Upload failed')
      spy.mockResolvedValueOnce('design-7')
      await expect(retry()).resolves.toBe(true)
      expect(handlers.onMigrated).toHaveBeenCalledWith('design-7')
    })
  })
})

describe('account adapter', () => {
  it('saves with base_revision, reports the new revision and uploads the thumbnail', async () => {
    let revision = 3
    const patches: unknown[] = []
    const calls = captureFetch((request) => {
      if (request.method === 'PATCH') {
        patches.push(JSON.parse(String(request.body)))
        return json({ id: 'd1', revision: 4 })
      }
      return json({ thumbnail_url: '/media/t.webp' })
    })
    const onRevision = vi.fn((next: number) => {
      revision = next
    })
    const adapter = createAccountAdapter('d1', () => revision, { onRevision })
    const result = await adapter.save({ ...snapshot(), thumbnail: new Blob(['t'], { type: 'image/webp' }) })
    expect(result.revision).toBe(4)
    expect(onRevision).toHaveBeenCalledWith(4)
    expect(patches[0]).toMatchObject({ title: 'Untitled design', base_revision: 3 })
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PUT'])
  })

  it('throttles thumbnail uploads', async () => {
    const calls = captureFetch((request) => (request.method === 'PATCH' ? json({ revision: 2 }) : json({ thumbnail_url: 'x' })))
    const adapter = createAccountAdapter('d1', () => 1, { thumbnailIntervalMs: 60_000 })
    const thumbnail = new Blob(['t'], { type: 'image/webp' })
    await adapter.save({ ...snapshot(), thumbnail })
    await adapter.save({ ...snapshot(), thumbnail })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('maps a 409 to RevisionConflictError (detectable by name) with the current revision', async () => {
    captureFetch(() => json({ error: { code: 'revision_conflict', message: 'Stale' }, current: { revision: 9 } }, 409))
    const adapter = createAccountAdapter('d1', () => 1)
    const error = (await adapter.save(snapshot()).catch((e: unknown) => e)) as Error & { currentRevision: number }
    expect(error.name).toBe('RevisionConflictError')
    expect(error.currentRevision).toBe(9)
  })

  it('does not mistake other 409 answers (e.g. limit_reached) for a revision conflict', async () => {
    captureFetch(() => json({ error: { code: 'limit_reached', message: 'Too many versions' } }, 409))
    const adapter = createAccountAdapter('d1', () => 1)
    const error = (await adapter.save(snapshot()).catch((e: unknown) => e)) as Error & { code?: string }
    expect(error.name).toBe('ApiError')
    expect(error.code).toBe('limit_reached')
  })

  it('passes other API errors through untouched', async () => {
    captureFetch(() => json({ error: { code: 'inline_asset_not_allowed', message: 'No blobs' } }, 400))
    const adapter = createAccountAdapter('d1', () => 1)
    await expect(adapter.save(snapshot())).rejects.toMatchObject({ code: 'inline_asset_not_allowed' })
  })

  it('maps uploaded assets to AssetRef and passes sources through', async () => {
    captureFetch(() => json({ id: 'a1', kind: 'image', name: 'cat.png', url: '/media/cat.png', thumb_url: '/media/cat-t.webp', width: 10, height: 20, size: 1, mime: 'image/png', tags: [], created_at: '' }, 201))
    const adapter = createAccountAdapter('d1', () => 1)
    await expect(adapter.uploadAsset(new File(['x'], 'cat.png', { type: 'image/png' }))).resolves.toEqual({ id: 'a1', url: '/media/cat.png', thumbUrl: '/media/cat-t.webp', width: 10, height: 20, name: 'cat.png', kind: 'image', video: null })
    await expect(adapter.resolveSrc('/media/x.png')).resolves.toBe('/media/x.png')
    await expect(adapter.requireAccount('save', async () => snapshot())).resolves.toBe(true)
  })

  it('offers brand, stock and versions services and server PDF only when the feature is on', async () => {
    const off = createAccountAdapter('d1', () => 1, { config: { features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: false } } })
    expect(off.exportPdf).toBeUndefined()
    expect(off.services.brand).not.toBeNull()
    expect(off.services.stock).not.toBeNull()
    expect(off.services.versions).not.toBeNull()
    const on = createAccountAdapter('d1', () => 1, { config: { features: { stock_photos: true, server_pdf: true, google_login: false, email_verification: false } } })
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const pdf = await on.exportPdf?.({ svgPages: ['<svg/>'], width: 100, height: 100, title: 'x' })
    expect(pdf?.size).toBe(4)
    expect((calls[0].body as FormData).getAll('pages')).toHaveLength(1)
  })

  it('hands the font files of the design to the server PDF export', async () => {
    const on = createAccountAdapter('d1', () => 1, { config: { features: { stock_photos: false, server_pdf: true, google_login: false, email_verification: false } } })
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const fonts = [{ family: 'Brand Sans', url: '/media/fonts/user/1/a.ttf', weight: 400, style: 'normal' as const }]
    await on.exportPdf?.({ svgPages: ['<svg/>'], width: 100, height: 100, fonts })
    expect(JSON.parse((calls[0].body as FormData).get('fonts') as string)).toEqual(fonts)
  })

  it('hands the print options, the sizes and the language of the design to the server PDF export', async () => {
    const on = createAccountAdapter('d1', () => 1, { config: { features: { stock_photos: false, server_pdf: true, google_login: false, email_verification: false } } })
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    await on.exportPdf?.({ svgPages: ['<svg/>', '<svg/>'], width: 100, height: 100, sizes: [{ width: 100, height: 100 }, { width: 50, height: 80 }], bleedMm: 3, cropMarks: true, lang: 'fr', title: 'Menu' })
    const form = calls[0].body as FormData
    expect(form.get('bleed_mm')).toBe('3')
    expect(form.get('crop_marks')).toBe('true')
    expect(form.get('lang')).toBe('fr')
    expect(JSON.parse(form.get('sizes') as string)).toEqual([{ width: 100, height: 100 }, { width: 50, height: 80 }])
  })

  it('gives signed-in users their own font library and everyone the public catalog', async () => {
    const adapter = createAccountAdapter('d1', () => 1)
    const calls = captureFetch(() => json({ count: 1, next: null, previous: null, results: [{ id: 'f1', family: 'Brand Sans' }] }))
    await expect(adapter.services.fonts.mine?.list()).resolves.toEqual([{ id: 'f1', family: 'Brand Sans' }])
    expect(calls[0].url.pathname).toBe('/api/v1/fonts/mine/')
    expect(typeof adapter.services.fonts.list).toBe('function')
  })

  it('restores a version and returns its document', async () => {
    const restored = createBlankDocument(50, 50)
    server.use(mswHttp.post('*/api/v1/designs/d1/versions/v1/restore/', () => HttpResponse.json({ id: 'd1', document: restored })))
    const adapter = createAccountAdapter('d1', () => 1)
    await expect(adapter.services.versions?.restore('v1')).resolves.toEqual(restored)
  })
})

describe('shared adapter', () => {
  const base = { token: 'tok', getRevision: () => 5, ensureSignedIn: vi.fn(async () => true) }

  it('visitors cannot upload fonts but get the fonts that came with the design', () => {
    const provided = [{ id: 'f1', family: 'Owner Script', category: 'handwriting' as const, scripts: ['latin'], is_variable: false, is_user_font: true, variants: [], popularity: 9999 }]
    const adapter = createSharedAdapter({ ...base, role: 'edit', fonts: provided })
    expect(adapter.services.fonts.mine).toBeUndefined()
    expect(adapter.services.fonts.provided).toEqual(provided)
    expect(createSharedAdapter({ ...base, role: 'view' }).services.fonts.provided).toEqual([])
  })

  it('view links are read-only', async () => {
    const adapter = createSharedAdapter({ ...base, role: 'view' })
    await expect(adapter.save(snapshot())).rejects.toBeInstanceOf(ReadOnlyDesignError)
    await expect(adapter.uploadAsset(new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toBeInstanceOf(ReadOnlyDesignError)
    expect(adapter.services.brand).toBeNull()
    expect((await adapter.services.assets.list({})).results).toEqual([])
  })

  it('comment links ask for an account via ensureSignedIn', async () => {
    const ensureSignedIn = vi.fn(async () => false)
    const adapter = createSharedAdapter({ ...base, role: 'comment', ensureSignedIn })
    await expect(adapter.requireAccount('comment', async () => snapshot())).resolves.toBe(false)
    expect(ensureSignedIn).toHaveBeenCalledWith('comment')
  })

  it('edit links PATCH through the token with the share password and track revisions', async () => {
    const onRevision = vi.fn()
    const calls = captureFetch(() => json({ revision: 6 }))
    const adapter = createSharedAdapter({ ...base, role: 'edit', password: 'hunter2', onRevision })
    const result = await adapter.save(snapshot())
    expect(result.revision).toBe(6)
    expect(onRevision).toHaveBeenCalledWith(6)
    expect(calls[0].url.pathname).toBe('/api/v1/shared/tok/')
    expect(calls[0].headers.get('x-share-password')).toBe('hunter2')
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ base_revision: 5 })
  })

  it('maps a share-edit conflict to RevisionConflictError', async () => {
    captureFetch(() => json({ error: { code: 'revision_conflict', message: 'Stale' }, current: { revision: 8 } }, 409))
    const adapter = createSharedAdapter({ ...base, role: 'edit' })
    await expect(adapter.save(snapshot())).rejects.toMatchObject({ name: 'RevisionConflictError', currentRevision: 8 })
  })
})
