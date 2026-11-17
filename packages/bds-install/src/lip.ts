// lip (github.com/LiteLDev/lip): the LeviLamina package manager bedperf drives to set up LeviLamina
// workspaces. Everything here only reads lip's files; commands run through an injectable exec.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ServerArtifact } from '@bedperf/core'
import { downloadFile, sha256File } from './ensure.ts'
import { execOk, type InstallExec } from './exec.ts'
import { renameRetry, tmpSuffix } from './fsutil.ts'
import type { FetchLike } from './resolve.ts'
import { hashTree, type SnapshotFile } from './snapshot.ts'

/** lip release bedperf downloads on Linux when `lip` is not on PATH. */
export const LIP_VERSION = '0.41.0'

export type HostOs = 'windows' | 'linux'

export function hostOs (): HostOs {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

type Env = Record<string, string | undefined>

function xdg (env: Env, name: string, fallback: string): string {
  const v = env[name]
  return v !== undefined && v !== '' && v.startsWith('/') ? v : join(env.HOME ?? homedir(), fallback)
}

/** lip's data dir (holds the Wine of lip): `%LOCALAPPDATA%\lip\Data` / `$XDG_DATA_HOME/lip` (default `~/.local/share/lip`). */
export function lipDataDir (os: HostOs = hostOs(), env: Env = process.env): string {
  return os === 'windows'
    ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'lip', 'Data')
    : join(xdg(env, 'XDG_DATA_HOME', join('.local', 'share')), 'lip')
}

/** lip's download cache: `%LOCALAPPDATA%\lip\Cache` / `$XDG_CACHE_HOME/lip` (default `~/.cache/lip`). */
export function lipCacheDir (os: HostOs = hostOs(), env: Env = process.env): string {
  return os === 'windows'
    ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'lip', 'Cache')
    : join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'lip')
}

/** lip caches an HTTP download as `<cache>/http-<sha256(url)>`. */
export function lipCachedDownload (url: string, cacheDir: string = lipCacheDir()): string {
  return join(cacheDir, 'http-' + createHash('sha256').update(url).digest('hex'))
}

/** The WINEPREFIX lip uses for a workspace (unless WINEPREFIX is set): `<workspace>/.lip/wine`. */
export function lipWinePrefix (workspace: string): string {
  return join(workspace, '.lip', 'wine')
}

/**
 * The Wine of lip: the Kron4ek archive is extracted into `<data>/wine/<build>/`, so the wine
 * program is `<data>/wine/<build>/<archive top dir>/bin/wine` (lip 0.41:
 * `wine-11.21-amd64-wow64/wine-11.21-amd64-wow64/bin/wine`); `<build>/bin/wine` is accepted too.
 * Returns `bin/wine`, `bin/wineserver` and the dir holding `bin/`. Undefined when lip has not installed it.
 */
export function findLipWine (dataDir: string = lipDataDir()): { wineBin: string, wineserverBin: string, buildDir: string } | undefined {
  const root = join(dataDir, 'wine')
  if (!existsSync(root)) return undefined
  const byVersion = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })
  const dirs = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.includes('.tmp'))
    .map(e => e.name)
    .sort(byVersion)
  for (const name of dirs(root).reverse()) {
    const build = join(root, name)
    const candidates = [build, ...dirs(build).reverse().map(s => join(build, s))]
    const buildDir = candidates.find(c => existsSync(join(c, 'bin', 'wine')))
    if (buildDir !== undefined) return { wineBin: join(buildDir, 'bin', 'wine'), wineserverBin: join(buildDir, 'bin', 'wineserver'), buildDir }
  }
  return undefined
}

/** First executable of `name` on PATH (`.exe` appended on Windows), or undefined. */
export function findOnPath (name: string, os: HostOs = hostOs(), env: Env = process.env): string | undefined {
  const file = os === 'windows' && !name.toLowerCase().endsWith('.exe') ? name + '.exe' : name
  const sep = os === 'windows' ? ';' : delimiter
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) {
    const d = dir.trim().replace(/^"|"$/g, '')
    if (d === '') continue
    const p = join(d, file)
    try {
      if (statSync(p).isFile()) return p
    } catch {}
  }
  return undefined
}

export interface LipTool {
  /** Command to run (`lip` from PATH, or the absolute path of a downloaded lip). */
  command: string
  version: string
  /** Absolute path of the binary when known. */
  path?: string
}

function parseLipVersion (out: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(out)?.[1]
}

/**
 * Find lip: `lipCommand` if given, else `lip` on PATH. On Linux without lip on PATH, download
 * `lip-<LIP_VERSION>-linux-x64.tar.xz` from GitHub (checked against the release's SHA256SUMS) into
 * `<toolsDir>/lip-<version>/` and use that.
 */
export async function ensureLip (opts: {
  exec: InstallExec
  toolsDir: string
  os?: HostOs
  lipCommand?: string
  fetch?: FetchLike
  log?: (line: string) => void
}): Promise<LipTool> {
  const os = opts.os ?? hostOs()
  const probe = async (command: string): Promise<string | undefined> => {
    try {
      const r = await opts.exec(command, ['--version'])
      return r.code === 0 ? parseLipVersion(r.stdout + r.stderr) : undefined
    } catch {
      return undefined
    }
  }
  const candidates = opts.lipCommand !== undefined ? [opts.lipCommand] : ['lip']
  for (const c of candidates) {
    const version = await probe(c)
    if (version !== undefined) {
      const path = c === 'lip' ? findOnPath('lip', os) : c
      return { command: c, version, ...(path !== undefined ? { path } : {}) }
    }
  }
  if (opts.lipCommand !== undefined) throw new Error(`lip command '${opts.lipCommand}' does not run`)
  if (os === 'windows') {
    throw new Error('lip is not on PATH. Install it from https://github.com/LiteLDev/lip/releases (lip-<version>-win-x64.msi) and retry.')
  }

  const dir = join(opts.toolsDir, `lip-${LIP_VERSION}`)
  const existing = findLipBinary(dir)
  if (existing !== undefined) {
    const version = await probe(existing)
    if (version !== undefined) return { command: existing, version, path: existing }
  }
  const asset = `lip-${LIP_VERSION}-linux-x64.tar.xz`
  const base = `https://github.com/LiteLDev/lip/releases/download/v${LIP_VERSION}`
  opts.log?.(`downloading ${base}/${asset}`)
  mkdirSync(opts.toolsDir, { recursive: true })
  const sumsRes = await (opts.fetch ?? fetch)(`${base}/SHA256SUMS`, { redirect: 'follow' })
  if (!sumsRes.ok) throw new Error(`cannot fetch ${base}/SHA256SUMS: HTTP ${sumsRes.status}`)
  const sums = await sumsRes.text()
  const expected = sums.split(/\r?\n/).map(l => l.trim().split(/\s+\*?/)).find(p => p[1] === asset)?.[0]?.toLowerCase()
  const archive = join(opts.toolsDir, asset)
  const { sha256 } = await downloadFile(`${base}/${asset}`, archive, { fetch: opts.fetch })
  if (expected === undefined || expected !== sha256) {
    await rm(archive, { force: true })
    throw new Error(`${asset}: sha256 ${sha256} does not match SHA256SUMS (${expected ?? 'missing'})`)
  }
  const tmp = dir + tmpSuffix()
  try {
    mkdirSync(tmp, { recursive: true })
    await execOk(opts.exec, 'tar', ['-xJf', archive, '-C', tmp])
    if (findLipBinary(tmp) === undefined) throw new Error(`${asset} contains no lip binary`)
    await rm(dir, { recursive: true, force: true })
    await renameRetry(tmp, dir)
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
  const bin = findLipBinary(dir)!
  chmodSync(bin, 0o755)
  const version = await probe(bin)
  if (version === undefined) throw new Error(`downloaded lip at ${bin} does not run`)
  return { command: bin, version, path: bin }
}

/** `lip` inside an extracted release (top level or one directory down). */
export function findLipBinary (dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  if (existsSync(join(dir, 'lip')) && statSync(join(dir, 'lip')).isFile()) return join(dir, 'lip')
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(dir, e.name, 'lip')) && statSync(join(dir, e.name, 'lip')).isFile()) return join(dir, e.name, 'lip')
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// .lip/state.json
// ---------------------------------------------------------------------------------------------------------------

export interface LipPackage {
  /** e.g. `github.com/LiteLDev/LeviLamina`. */
  id: string
  version: string
  commit?: string
  /** Workspace-relative files the package placed. */
  files: string[]
  /** Download URLs of the package's assets (variant of the workspace). */
  urls: string[]
}

export interface LipState { platform?: string, packages: LipPackage[] }

interface RawState {
  platform?: string
  packages?: Array<{
    manifest?: { id?: string, version?: string, variants?: Record<string, Array<{ platform?: string, assets?: Array<{ urls?: string[] }> }>> }
    variant?: string
    commit?: string
    files?: string[]
  }>
}

/** Parse `<workspace>/.lip/state.json`. */
export function readLipState (workspace: string): LipState {
  const file = join(workspace, '.lip', 'state.json')
  if (!existsSync(file)) throw new Error(`${file} not found: lip did not set up this workspace`)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawState
  const packages: LipPackage[] = []
  for (const p of raw.packages ?? []) {
    const id = p.manifest?.id
    const version = p.manifest?.version
    if (typeof id !== 'string' || typeof version !== 'string') continue
    const variants = p.manifest?.variants ?? {}
    const entries = variants[p.variant ?? ''] ?? []
    const match = entries.filter(v => raw.platform === undefined || v.platform === undefined || v.platform === raw.platform)
    const urls = (match.length > 0 ? match : entries).flatMap(v => v.assets ?? []).flatMap(a => a.urls ?? [])
    packages.push({
      id,
      version,
      ...(typeof p.commit === 'string' ? { commit: p.commit } : {}),
      files: Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [],
      urls
    })
  }
  return { ...(raw.platform !== undefined ? { platform: raw.platform } : {}), packages }
}

/** `hashTree` restricted to the given workspace-relative files (those that exist). */
export function hashFiles (root: string, relPaths: readonly string[]): string {
  const files: SnapshotFile[] = []
  for (const p of new Set(relPaths)) {
    const full = join(root, ...p.split('/'))
    try {
      const st = statSync(full)
      if (st.isFile()) files.push({ path: p, size: st.size })
    } catch {}
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return hashTree(root, files)
}

/** Artifact name of a lip package id: its last path segment, lower-cased (`LeviLamina` → `levilamina`). */
export function lipArtifactName (id: string): string {
  return (id.split('/').at(-1) ?? id).toLowerCase()
}

/** The full BDS version (`1.26.60.6`) of the zip lip installed, from its download URL. */
export function lipBdsVersion (state: LipState): string | undefined {
  const bds = state.packages.find(p => lipArtifactName(p.id) === 'bds')
  for (const u of bds?.urls ?? []) {
    const m = /bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip/.exec(u)
    if (m) return m[1]
  }
  return undefined
}

/**
 * One artifact per package lip installed. `bds`: sha256 of the downloaded zip when it is still in
 * lip's cache, else the hash of the files lip placed. Others: the hash of the files lip placed
 * (`hashFiles`), with `source` = `<id>@<version>#<commit>`.
 */
export async function lipArtifacts (workspace: string, state: LipState, cacheDir: string = lipCacheDir()): Promise<ServerArtifact[]> {
  const out: ServerArtifact[] = []
  for (const p of state.packages) {
    const name = lipArtifactName(p.id)
    if (name === 'bds') {
      const url = p.urls[0]
      const cached = url !== undefined ? lipCachedDownload(url, cacheDir) : undefined
      const sha256 = cached !== undefined && existsSync(cached) ? await sha256File(cached) : hashFiles(workspace, p.files)
      out.push({ name, version: lipBdsVersion(state) ?? p.version, sha256, ...(url !== undefined ? { source: url } : {}) })
      continue
    }
    out.push({
      name,
      version: p.version,
      sha256: hashFiles(workspace, p.files),
      source: `${p.id}@${p.version}${p.commit !== undefined ? '#' + p.commit : ''}`
    })
  }
  return out
}
