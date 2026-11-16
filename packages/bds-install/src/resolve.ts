import type { Platform } from './platform.ts'
import { hostPlatform } from './platform.ts'

/** Minimal fetch signature, so tests can inject a mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const LINKS_API_URL = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links'
/** The links API and minecraft.net hang on requests without a browser-like User-Agent. */
export const USER_AGENT = 'Mozilla/5.0 (bedperf)'
export const DOWNLOAD_BASE_URL = 'https://www.minecraft.net/bedrockdedicatedserver'

export type Channel = 'latest' | 'preview'

export interface ResolvedBds {
  /** Four-part BDS version, e.g. '1.26.63.1'. */
  version: string
  /** Zip download URL. */
  url: string
  platform: Platform
  preview: boolean
}

export interface ResolveOptions {
  fetch?: FetchLike
  /** Links API timeout, ms. Default 15000. */
  timeoutMs?: number
  /** For an explicit version: build the preview URL. Default false. */
  preview?: boolean
}

const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/

export function isExplicitVersion (v: string): boolean {
  return VERSION_RE.test(v)
}

/** `downloadType` value of the links API for a platform / channel. */
export function downloadTypeOf (platform: Platform, preview: boolean): string {
  return `serverBedrock${preview ? 'Preview' : ''}${platform === 'win' ? 'Windows' : 'Linux'}`
}

/** Download URL of an explicit version, following the minecraft.net pattern. */
export function buildDownloadUrl (version: string, platform: Platform, preview = false): string {
  if (!isExplicitVersion(version)) throw new Error(`invalid BDS version '${version}' (expected x.y.z.w)`)
  const dir = `bin-${platform === 'win' ? 'win' : 'linux'}${preview ? '-preview' : ''}`
  return `${DOWNLOAD_BASE_URL}/${dir}/bedrock-server-${version}.zip`
}

/** Extracts the version from a download URL like `.../bedrock-server-1.26.63.1.zip`. */
export function versionFromUrl (url: string): string | undefined {
  return /bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip(?:$|[?#])/.exec(url)?.[1]
}

interface LinksResponse {
  result?: { links?: Array<{ downloadType?: unknown, downloadUrl?: unknown }> }
}

/** Picks the entry for `platform`/`preview` from a links API response body. Throws if absent. */
export function parseLinksResponse (body: unknown, platform: Platform, preview: boolean): ResolvedBds {
  const links = (body as LinksResponse | null)?.result?.links
  if (!Array.isArray(links)) throw new Error('unexpected links API response: missing result.links[]')
  const type = downloadTypeOf(platform, preview)
  const hit = links.find(l => l?.downloadType === type)
  if (!hit || typeof hit.downloadUrl !== 'string') {
    throw new Error(`links API has no '${type}' entry (have: ${links.map(l => String(l?.downloadType)).join(', ')})`)
  }
  const version = versionFromUrl(hit.downloadUrl)
  if (!version) throw new Error(`cannot parse a version from download URL ${hit.downloadUrl}`)
  return { version, url: hit.downloadUrl, platform, preview }
}

/**
 * Resolve a BDS channel (`latest`, `preview`) or an explicit `x.y.z.w` version to a download.
 * Channels query the official links API; explicit versions are built from the URL pattern
 * without network access.
 */
export async function resolveVersion (
  channel: Channel | string,
  platform: Platform = hostPlatform(),
  opts: ResolveOptions = {}
): Promise<ResolvedBds> {
  if (isExplicitVersion(channel)) {
    const preview = opts.preview ?? false
    return { version: channel, url: buildDownloadUrl(channel, platform, preview), platform, preview }
  }
  if (channel !== 'latest' && channel !== 'preview') {
    throw new Error(`unknown BDS channel '${channel}' (expected 'latest', 'preview' or x.y.z.w)`)
  }
  const doFetch = opts.fetch ?? fetch
  const res = await doFetch(LINKS_API_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
  })
  if (!res.ok) throw new Error(`links API returned HTTP ${res.status}`)
  return parseLinksResponse(await res.json(), platform, channel === 'preview')
}
