import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { renameRetry, tmpSuffix } from './fsutil.ts'
import { extractZip } from './zip.ts'
import { defaultBdsCacheRoot, hostPlatform, serverExeName, versionDirName, type Platform } from './platform.ts'
import { isExplicitVersion, resolveVersion, USER_AGENT, type FetchLike, type ResolvedBds } from './resolve.ts'

export interface EnsureOptions {
  /** Must be `true`: downloading BDS means accepting the Minecraft EULA (https://www.minecraft.net/eula). */
  acceptEula: boolean
  /** Cache root holding `<version>/` and the zips. Default: same as testkit's `bdsCacheRoot()`. */
  cacheRoot?: string
  platform?: Platform
  /** For an explicit version: it is a preview build. */
  preview?: boolean
  fetch?: FetchLike
  /** Abort the download if no bytes arrive for this long, ms. Default 60000. */
  idleTimeoutMs?: number
  /** Keep the zip next to the extracted dir after extraction. Default true. */
  keepZip?: boolean
  onProgress?: (p: { phase: 'download' | 'extract', received?: number, total?: number }) => void
}

/** Written to `<cacheRoot>/<version>.json` after a verified download. */
export interface BdsSidecar {
  version: string
  platform: Platform
  preview: boolean
  url: string
  zip: string
  size: number
  sha256: string
  downloadedAt: string
  extractedAt?: string
}

export interface EnsureResult {
  /** Absolute pristine dir. Never modify files in it. */
  dir: string
  version: string
  platform: Platform
  /** True when nothing had to be downloaded or extracted. */
  cached: boolean
}

export function zipFileName (version: string, platform: Platform = hostPlatform()): string {
  return platform === hostPlatform() ? `bedrock-server-${version}.zip` : `bedrock-server-${version}-${platform}.zip`
}

export function sidecarPath (cacheRoot: string, version: string, platform: Platform = hostPlatform()): string {
  return join(cacheRoot, `${versionDirName(version, platform)}.json`)
}

export function readSidecar (cacheRoot: string, version: string, platform: Platform = hostPlatform()): BdsSidecar | undefined {
  try {
    return JSON.parse(readFileSync(sidecarPath(cacheRoot, version, platform), 'utf8')) as BdsSidecar
  } catch {
    return undefined
  }
}

/**
 * sha256 of the downloaded zip of `version`, as recorded in the cache sidecar after a verified download
 * (for run provenance). Undefined when the build was not downloaded by bds-install (no sidecar).
 */
export function bdsZipSha256 (version: string, opts: { cacheRoot?: string, platform?: Platform } = {}): string | undefined {
  const s = readSidecar(opts.cacheRoot ?? defaultBdsCacheRoot(), version, opts.platform ?? hostPlatform())
  return typeof s?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256) ? s.sha256 : undefined
}

export async function sha256File (file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/**
 * Stream `url` to `dest` atomically (temp file + rename). Verifies the byte count against
 * content-length and returns size and sha256.
 */
export async function downloadFile (
  url: string,
  dest: string,
  opts: { fetch?: FetchLike, idleTimeoutMs?: number, onProgress?: (received: number, total?: number) => void } = {}
): Promise<{ size: number, sha256: string }> {
  const doFetch = opts.fetch ?? fetch
  const idleMs = opts.idleTimeoutMs ?? 60_000
  const ac = new AbortController()
  let timer = setTimeout(() => ac.abort(new Error(`download stalled for ${idleMs} ms: ${url}`)), idleMs)
  const kick = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ac.abort(new Error(`download stalled for ${idleMs} ms: ${url}`)), idleMs)
  }
  const tmp = dest + tmpSuffix()
  try {
    const res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ac.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
    const lenHeader = res.headers.get('content-length')
    // With a Content-Encoding, fetch decodes the body and content-length counts encoded bytes.
    const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity'
    const expected = lenHeader !== null && lenHeader !== '' && !encoded ? Number(lenHeader) : undefined
    const hash = createHash('sha256')
    let received = 0
    const tap = new Transform({
      transform (chunk: Buffer, _enc, cb) {
        kick()
        hash.update(chunk)
        received += chunk.length
        opts.onProgress?.(received, expected)
        cb(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), tap, createWriteStream(tmp))
    if (expected !== undefined && Number.isFinite(expected) && received !== expected) {
      throw new Error(`download size mismatch for ${url}: got ${received} bytes, content-length ${expected}`)
    }
    await renameRetry(tmp, dest)
    return { size: received, sha256: hash.digest('hex') }
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Make sure an extracted, pristine BDS build exists in the cache and return its directory.
 * `version` is an explicit `x.y.z.w`, a `ResolvedBds`, or a channel ('latest' / 'preview',
 * resolved through the links API).
 *
 * Already-extracted versions are returned without any network access or file writes. Otherwise
 * the zip is downloaded (unless a zip matching the sidecar sha256 is present), verified,
 * extracted into a temp dir and renamed into place.
 */
export async function ensureBds (version: string | ResolvedBds, opts: EnsureOptions): Promise<EnsureResult> {
  if (opts?.acceptEula !== true) {
    throw new Error('Refusing to download BDS: pass { acceptEula: true } to accept the Minecraft EULA (https://www.minecraft.net/eula)')
  }
  const cacheRoot = opts.cacheRoot ?? defaultBdsCacheRoot()
  const platform = typeof version === 'string' ? (opts.platform ?? hostPlatform()) : version.platform

  // Fast path for explicit versions: no network when it is already extracted.
  if (typeof version === 'string' && isExplicitVersion(version)) {
    const dir = join(cacheRoot, versionDirName(version, platform))
    if (existsSync(join(dir, serverExeName(platform)))) return { dir, version, platform, cached: true }
  }

  const resolved = typeof version === 'string'
    ? await resolveVersion(version, platform, { fetch: opts.fetch, preview: opts.preview })
    : version
  const dir = join(cacheRoot, versionDirName(resolved.version, platform))
  const exe = serverExeName(platform)
  if (existsSync(join(dir, exe))) return { dir, version: resolved.version, platform, cached: true }

  mkdirSync(cacheRoot, { recursive: true })
  const zip = join(cacheRoot, zipFileName(resolved.version, platform))
  let sidecar = readSidecar(cacheRoot, resolved.version, platform)
  const zipOk = sidecar !== undefined && existsSync(zip) &&
    statSync(zip).size === sidecar.size && await sha256File(zip) === sidecar.sha256
  if (!zipOk) {
    const { size, sha256 } = await downloadFile(resolved.url, zip, {
      fetch: opts.fetch,
      idleTimeoutMs: opts.idleTimeoutMs,
      onProgress: (received, total) => opts.onProgress?.({ phase: 'download', received, total })
    })
    sidecar = {
      version: resolved.version,
      platform,
      preview: resolved.preview,
      url: resolved.url,
      zip: zipFileName(resolved.version, platform),
      size,
      sha256,
      downloadedAt: new Date().toISOString()
    }
    await writeJsonAtomic(sidecarPath(cacheRoot, resolved.version, platform), sidecar)
  }

  opts.onProgress?.({ phase: 'extract' })
  const tmpDir = dir + tmpSuffix()
  try {
    await extractZip(zip, tmpDir)
    if (!existsSync(join(tmpDir, exe))) throw new Error(`${zip} does not contain ${exe}; is it a ${platform} BDS build?`)
    try {
      await renameRetry(tmpDir, dir, () => existsSync(join(dir, exe)))
    } catch (err) {
      // Another process won the race: keep its copy.
      if (!existsSync(join(dir, exe))) throw err
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  await writeJsonAtomic(sidecarPath(cacheRoot, resolved.version, platform), { ...sidecar!, extractedAt: new Date().toISOString() })
  if (opts.keepZip === false) await rm(zip, { force: true })
  return { dir, version: resolved.version, platform, cached: false }
}

async function writeJsonAtomic (file: string, data: unknown): Promise<void> {
  const tmp = file + tmpSuffix()
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
  await renameRetry(tmp, file)
}
