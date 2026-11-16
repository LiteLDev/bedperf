import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bdsZipSha256, ensureBds, readSidecar, zipFileName } from './ensure.ts'
import { hostPlatform, serverExeName } from './platform.ts'
import type { FetchLike } from './resolve.ts'
import { makeFakeBdsZip } from './testutil.ts'

const V = '9.9.9.9'

function zipFetch (zip: Uint8Array, opts: { contentLength?: number } = {}): { fetch: FetchLike, urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: async (url) => {
      urls.push(url)
      return new Response(zip.slice(), { headers: { 'content-length': String(opts.contentLength ?? zip.length) } })
    }
  }
}

test('ensureBds refuses without acceptEula: true', async () => {
  const failFetch: FetchLike = async () => { throw new Error('must not fetch') }
  await assert.rejects(ensureBds(V, { acceptEula: false, fetch: failFetch }), /EULA/)
  await assert.rejects(ensureBds(V, {} as { acceptEula: boolean }), /EULA/)
  await assert.rejects(ensureBds(V, { acceptEula: 'yes' } as unknown as { acceptEula: boolean }), /EULA/)
})

test('ensureBds downloads, verifies, extracts, records sha256 and then skips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-cache-'))
  try {
    const zip = makeFakeBdsZip(serverExeName())
    const m = zipFetch(zip)
    const r = await ensureBds(V, { acceptEula: true, cacheRoot: root, fetch: m.fetch })
    assert.equal(r.dir, join(root, V))
    assert.equal(r.cached, false)
    assert.equal(m.urls.length, 1)
    assert.match(m.urls[0]!, new RegExp(`/bedrock-server-${V}\\.zip$`))
    assert.ok(existsSync(join(r.dir, serverExeName())))
    assert.ok(existsSync(join(root, zipFileName(V))))
    const side = readSidecar(root, V)!
    assert.equal(side.sha256, createHash('sha256').update(zip).digest('hex'))
    assert.equal(side.size, zip.length)
    assert.equal(side.platform, hostPlatform())
    assert.ok(side.extractedAt)
    assert.equal(bdsZipSha256(V, { cacheRoot: root }), side.sha256)
    assert.equal(bdsZipSha256('1.2.3.4', { cacheRoot: root }), undefined)
    assert.deepEqual(readdirSync(root).filter(n => n.includes('.tmp-')), [])

    const again = await ensureBds(V, { acceptEula: true, cacheRoot: root, fetch: m.fetch })
    assert.equal(again.cached, true)
    assert.equal(m.urls.length, 1, 'no second download')

    // Zip present + sidecar match but no extracted dir: re-extract without downloading.
    rmSync(r.dir, { recursive: true })
    const re = await ensureBds(V, { acceptEula: true, cacheRoot: root, fetch: m.fetch })
    assert.equal(re.cached, false)
    assert.equal(m.urls.length, 1)
    assert.ok(existsSync(join(r.dir, serverExeName())))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureBds rejects a truncated download and leaves no files behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-cache-'))
  try {
    const zip = makeFakeBdsZip(serverExeName())
    const m = zipFetch(zip, { contentLength: zip.length + 10 })
    await assert.rejects(ensureBds(V, { acceptEula: true, cacheRoot: root, fetch: m.fetch }), /size mismatch/)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureBds does not touch an existing extracted dir (no sidecar needed)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-cache-'))
  try {
    mkdirSync(join(root, V))
    writeFileSync(join(root, V, serverExeName()), 'x')
    const failFetch: FetchLike = async () => { throw new Error('must not fetch') }
    const r = await ensureBds(V, { acceptEula: true, cacheRoot: root, fetch: failFetch })
    assert.equal(r.cached, true)
    assert.deepEqual(readdirSync(root), [V])
    assert.equal(readFileSync(join(root, V, serverExeName()), 'utf8'), 'x')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
