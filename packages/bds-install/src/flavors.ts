// ensureServer: install any server flavor (vanilla BDS, LeviLamina [+ mods] natively or under Wine,
// Endstone) into the bedperf cache and describe how to launch an instance of it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bdsVersionFor, NEUTRAL_LOADER_CONFIG, resolveServerSpec, serverBuildSha256, serverLabel, serverSpecSha256, sha256Json,
  type LaunchSpec, type ServerArtifact, type ServerBuildInfo, type ServerMod, type ServerSpec
} from '@bedperf/core'
import { bdsZipSha256, ensureBds, sha256File } from './ensure.ts'
import { defaultExec, execOk, type InstallExec } from './exec.ts'
import { ENDSTONE_WINDOWS_LAUNCHER, findPython, installEndstone, venvBin } from './endstone.ts'
import { copyPristine } from './instance.ts'
import {
  ensureLip, findLipWine, lipArtifacts, lipBdsVersion, lipCacheDir, lipDataDir, lipWinePrefix, readLipState, type HostOs
} from './lip.ts'
import { cacheBaseDir, hostPlatform, serverExeName, type Platform } from './platform.ts'
import type { FetchLike } from './resolve.ts'
import { hashTree } from './snapshot.ts'

export interface EnsureServerOptions {
  /** Must be `true`: installing any flavor downloads BDS, which means accepting the Minecraft EULA. */
  acceptEula: boolean
  /** bedperf cache root (parent of `bds/`, `servers/`, `tools/`). Default: `cacheBaseDir()`. */
  cacheRoot?: string
  /** Vanilla BDS cache. Default `<cacheRoot>/bds`. */
  bdsCacheRoot?: string
  /**
   * Requested BDS version (`latest`, `preview` or `x.y.z.w`), mapped through `bdsVersionFor`: modded
   * flavors use their pinned build unless an explicit version is given. Default `latest`.
   */
  bdsVersion?: string
  /** Platform of the host that runs the server. Default: this host. */
  hostPlatform?: Platform
  /** Runs lip, python, pip, wine and tar. Default: spawn. */
  exec?: InstallExec
  fetch?: FetchLike
  log?: (line: string) => void
  /** lip command (default `lip` on PATH; downloaded on Linux when missing). */
  lipCommand?: string
  /** Python >= 3.11 for Endstone (default: `python`/`py -3` on Windows, `python3`/`python` on Linux). */
  python?: string
  /** lip's dirs, for tests. Default: lip's own (respecting XDG_* on Linux). */
  lipDataDir?: string
  lipCacheDir?: string
}

/** A server build installed in the cache. */
export interface InstalledServer {
  build: ServerBuildInfo
  /** Pristine dir `createInstance` copies from. Never modified (except the shared Wine prefix in `.lip/wine`). */
  pristineDir: string
  /** How to start the server in an instance created from `pristineDir`. */
  launch: (instanceDir: string) => LaunchSpec
  /** Files `createInstance` writes into every instance (instance-relative '/'-path → content), e.g. the loader config. */
  instanceFiles?: Record<string, string>
}

/** Written last into `<root>/` by an install; without it the install is redone. */
export const SERVER_COMPLETE_MARKER = '.bedperf-complete.json'
const MARKER_FORMAT = 2

interface Marker {
  format: number
  build: Omit<ServerBuildInfo, 'loaderConfig'>
  wine?: { prefix: string, wineBin: string, wineserverBin: string, version?: string }
  venv?: string
}

/** lip package of each LeviLamina mod. */
export const MOD_PACKAGES: Record<ServerMod, string> = {
  levioptimize: 'github.com/LiteLDev/LeviOptimize'
}

/** LeviLamina's config file inside the server dir. */
export const LEVILAMINA_CONFIG_PATH = 'mods/LeviLamina/config/Config.json'

/** Process names (Linux `comm`, truncated to 15 chars) of Wine's helper processes. */
export const WINE_AUX_PROCESS_PATTERNS = ['^wineserver$', '^(services|winedevice|plugplay|explorer|rpcss|svchost|lsass)\\.exe$']

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge of plain objects; arrays and scalars in `over` replace. Inputs are not modified. */
export function deepMerge (base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(base)
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : structuredClone(v)
  }
  return out
}

/** Effective loader config of a spec: `NEUTRAL_LOADER_CONFIG[flavor]` deep-merged with `spec.loaderConfig`. */
export function effectiveLoaderConfig (spec: ServerSpec): Record<string, unknown> {
  return deepMerge(NEUTRAL_LOADER_CONFIG[spec.flavor], spec.loaderConfig)
}

/** `levilamina+levioptimize (wine)` → `levilamina-levioptimize-wine`. */
export function serverSlug (spec: ServerSpec): string {
  return serverLabel(spec).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Cache dir of a modded build: `<cacheRoot>/servers/<slug>-<hash12>`, keyed by `serverSpecSha256`
 * and the BDS version (the loader config is per instance, so it is not part of the key).
 */
export function serverCacheDir (spec: ServerSpec, bdsVersion: string, cacheRoot: string = cacheBaseDir()): string {
  const key = sha256Json({ spec: serverSpecSha256(spec), bdsVersion }).slice(0, 12)
  return join(cacheRoot, 'servers', `${serverSlug(spec)}-${key}`)
}

function toHostOs (p: Platform): HostOs {
  return p === 'win' ? 'windows' : 'linux'
}

function readMarker (root: string): Marker | undefined {
  try {
    const m = JSON.parse(readFileSync(join(root, SERVER_COMPLETE_MARKER), 'utf8')) as Marker
    return m.format === MARKER_FORMAT ? m : undefined
  } catch {
    return undefined
  }
}

function writeMarker (root: string, marker: Marker): void {
  writeFileSync(join(root, SERVER_COMPLETE_MARKER), JSON.stringify(marker, null, 2) + '\n')
}

function finishBuild (b: Omit<ServerBuildInfo, 'buildSha256' | 'label' | 'specSha256'>): Omit<ServerBuildInfo, 'loaderConfig'> {
  return {
    ...b,
    label: serverLabel(b.spec),
    specSha256: serverSpecSha256(b.spec),
    buildSha256: serverBuildSha256(b.artifacts)
  }
}

/** Build info for this call: the cached build plus the requested loader config. */
function withLoaderConfig (build: Omit<ServerBuildInfo, 'loaderConfig'>, spec: ServerSpec, loaderConfig?: Record<string, unknown>): ServerBuildInfo {
  const { loaderConfig: _drop, ...b } = build as ServerBuildInfo
  return { ...b, spec, ...(loaderConfig !== undefined ? { loaderConfig } : {}) }
}

/**
 * Install (or find in the cache) the server described by `spec` and return how to run it.
 * - `bds`: `ensureBds` (vanilla cache untouched).
 * - `levilamina` (+ mods): `lip setup` + `lip install` in `<cacheRoot>/servers/<slug>-<hash>/server`;
 *   native on Windows, under lip's Wine on Linux (`runtime: 'wine'`).
 * - `endstone`: a venv with `endstone==<v>` plus a copy of the matching vanilla BDS.
 * Modded installs end by writing `.bedperf-complete.json`; an install without it is redone from scratch.
 */
export async function ensureServer (specIn: ServerSpec | undefined, opts: EnsureServerOptions): Promise<InstalledServer> {
  if (opts?.acceptEula !== true) {
    throw new Error('Refusing to install a server: pass { acceptEula: true } to accept the Minecraft EULA (https://www.minecraft.net/eula)')
  }
  const spec = resolveServerSpec(specIn)
  const platform = opts.hostPlatform ?? hostPlatform()
  const os = toHostOs(platform)
  const ctx: Ctx = {
    opts,
    platform,
    os,
    cacheRoot: opts.cacheRoot ?? cacheBaseDir(),
    bdsCacheRoot: opts.bdsCacheRoot ?? join(opts.cacheRoot ?? cacheBaseDir(), 'bds'),
    exec: opts.exec ?? defaultExec(opts.log),
    log: opts.log ?? (() => {}),
    bdsVersion: bdsVersionFor(spec, opts.bdsVersion ?? 'latest')
  }
  switch (spec.flavor) {
    case 'bds': return await ensureVanilla(spec, ctx)
    case 'levilamina': return await ensureLeviLamina(spec, ctx)
    case 'endstone': return await ensureEndstone(spec, ctx)
    default: throw new Error(`unknown server flavor '${(spec as ServerSpec).flavor}'`)
  }
}

interface Ctx {
  opts: EnsureServerOptions
  platform: Platform
  os: HostOs
  cacheRoot: string
  bdsCacheRoot: string
  exec: InstallExec
  log: (line: string) => void
  bdsVersion: string
}

// ---------------------------------------------------------------------------------------------------------------
// vanilla BDS
// ---------------------------------------------------------------------------------------------------------------

/** LaunchSpec of vanilla BDS in `dir` (Linux: LD_LIBRARY_PATH = the instance dir, prepended). */
export function vanillaLaunch (dir: string, platform: Platform, env: Record<string, string | undefined> = process.env): LaunchSpec {
  const exe = serverExeName(platform)
  return {
    command: join(dir, exe),
    args: [],
    cwd: dir,
    ...(platform === 'linux' ? { env: { LD_LIBRARY_PATH: [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':') } } : {}),
    serverProcess: { namePattern: '^bedrock_server(\\.exe)?$' },
    killTree: false
  }
}

async function ensureVanilla (spec: ServerSpec, ctx: Ctx): Promise<InstalledServer> {
  if (spec.runtime === 'wine') return await ensureLipServer(spec, ctx)
  const r = await ensureBds(ctx.bdsVersion, { acceptEula: true, cacheRoot: ctx.bdsCacheRoot, platform: ctx.platform, fetch: ctx.opts.fetch })
  const sha256 = bdsZipSha256(r.version, { cacheRoot: ctx.bdsCacheRoot, platform: ctx.platform })
  const notes: string[] = []
  if (sha256 === undefined) notes.push(`BDS ${r.version} was not downloaded by bedperf (no sidecar), so its zip sha256 is unknown`)
  const build = finishBuild({
    spec,
    bdsVersion: r.version,
    binaryPlatform: ctx.platform,
    exeName: serverExeName(ctx.platform),
    artifacts: [{ name: 'bds', version: r.version, ...(sha256 !== undefined ? { sha256 } : {}) }],
    notes
  })
  const platform = ctx.platform
  return { build: withLoaderConfig(build, spec), pristineDir: r.dir, launch: dir => vanillaLaunch(dir, platform) }
}


// ---------------------------------------------------------------------------------------------------------------
// LeviLamina (lip)
// ---------------------------------------------------------------------------------------------------------------

export const LEVILAMINA_EXE = 'bedrock_server_mod.exe'
const LIP_ATTEMPTS = 3

/** `1.26.60.6` → `1.26.60` (lip's `--game` takes the three-part game version). */
export function lipGameVersion (bdsVersion: string): string {
  return bdsVersion.split('.').slice(0, 3).join('.')
}

/** Vanilla BDS's Windows executable (run under Wine by the `bds` flavor with `runtime: 'wine'`). */
export const VANILLA_WIN_EXE = 'bedrock_server.exe'

/** Executable lip leaves in the workspace for `spec`. */
function lipExe (spec: ServerSpec): string {
  return spec.flavor === 'bds' ? VANILLA_WIN_EXE : LEVILAMINA_EXE
}

/**
 * The lip commands that set up a workspace for `spec` (each runs with cwd = the workspace).
 * Vanilla BDS (`bds` under Wine) is set up without a loader.
 */
export function lipSetupCommands (spec: ServerSpec, bdsVersion: string): string[][] {
  const r = resolveServerSpec(spec)
  if (r.flavor === 'bds') return [['setup', '--game', lipGameVersion(bdsVersion), '--no-loader', '--accept-eula']]
  const cmds = [['setup', '--game', lipGameVersion(bdsVersion), '--loader', `levilamina@${r.versions.levilamina!}`, '--accept-eula']]
  for (const m of r.mods) {
    const v = m === 'levioptimize' ? r.versions.levioptimize : undefined
    cmds.push(['install', `${MOD_PACKAGES[m]}${v !== undefined ? '@' + v : ''}`])
  }
  return cmds
}

/** LaunchSpec of vanilla BDS's Windows build in `dir` under lip's Wine. */
export function vanillaWineLaunch (dir: string, wine: NonNullable<Marker['wine']>): LaunchSpec {
  return {
    command: wine.wineBin,
    args: [join(dir, VANILLA_WIN_EXE)],
    cwd: dir,
    env: { WINEPREFIX: wine.prefix, WINEDEBUG: '-all' },
    // Linux truncates comm to 15 chars: `bedrock_server.`.
    serverProcess: { namePattern: '^bedrock_server(\\.(exe)?)?$' },
    auxProcessPatterns: [...WINE_AUX_PROCESS_PATTERNS],
    killTree: true,
    wine: { prefix: wine.prefix, wineBin: wine.wineBin, wineserverBin: wine.wineserverBin, ...(wine.version !== undefined ? { version: wine.version } : {}) }
  }
}

/** LaunchSpec of LeviLamina in `dir`: the PeEditor-patched exe, natively or with lip's Wine. */
export function leviLaminaLaunch (dir: string, wine?: Marker['wine']): LaunchSpec {
  const exe = join(dir, LEVILAMINA_EXE)
  if (wine === undefined) {
    return {
      command: exe,
      args: [],
      cwd: dir,
      serverProcess: { namePattern: '^bedrock_server_mod(\\.exe)?$' },
      // LeviLamina's CrashLogger runs as a child process.
      killTree: true
    }
  }
  return {
    command: wine.wineBin,
    args: [exe],
    cwd: dir,
    env: { WINEPREFIX: wine.prefix, WINEDEBUG: '-all' },
    // Linux truncates comm to 15 chars: `bedrock_server_`.
    serverProcess: { namePattern: '^bedrock_server_(mod(\\.exe)?)?$' },
    auxProcessPatterns: [...WINE_AUX_PROCESS_PATTERNS],
    killTree: true,
    wine: { prefix: wine.prefix, wineBin: wine.wineBin, wineserverBin: wine.wineserverBin, ...(wine.version !== undefined ? { version: wine.version } : {}) }
  }
}

async function ensureLeviLamina (spec: ServerSpec, ctx: Ctx): Promise<InstalledServer> {
  if (spec.runtime === 'native' && ctx.os !== 'windows') {
    throw new Error('LeviLamina is Windows-only: on Linux use runtime \'wine\' (e.g. preset levilamina-wine)')
  }
  if (spec.runtime === 'wine' && ctx.os === 'windows') {
    throw new Error('runtime \'wine\' runs the Windows build of LeviLamina on Linux; on Windows use runtime \'native\'')
  }
  return await ensureLipServer(spec, ctx)
}

/** LeviLamina (+ mods), or vanilla BDS's Windows build under Wine: a lip workspace in the cache. */
async function ensureLipServer (spec: ServerSpec, ctx: Ctx): Promise<InstalledServer> {
  if (spec.flavor === 'bds' && ctx.os === 'windows') {
    throw new Error('runtime \'wine\' runs the Windows build of BDS on Linux; on Windows use runtime \'native\'')
  }
  const root = serverCacheDir(spec, ctx.bdsVersion, ctx.cacheRoot)
  const ws = join(root, 'server')
  const exe = lipExe(spec)
  const vanilla = spec.flavor === 'bds'
  const effective = vanilla ? undefined : effectiveLoaderConfig(spec)

  let marker = readMarker(root)
  if (marker === undefined || !existsSync(join(ws, exe))) {
    marker = await installLipServer(spec, ctx, root, ws)
  } else {
    ctx.log(`using cached ${marker.build.label} at ${ws}`)
  }
  const wine = marker.wine
  if (vanilla) {
    if (wine === undefined) throw new Error(`cached ${marker.build.label} at ${ws} has no Wine recorded; delete ${root} to reinstall`)
    return { build: withLoaderConfig(marker.build, spec), pristineDir: ws, launch: dir => vanillaWineLaunch(dir, wine) }
  }
  return {
    build: withLoaderConfig(marker.build, spec, effective),
    pristineDir: ws,
    launch: dir => leviLaminaLaunch(dir, wine),
    instanceFiles: { [LEVILAMINA_CONFIG_PATH]: JSON.stringify(effective, null, 4) + '\n' }
  }
}

async function installLipServer (spec: ServerSpec, ctx: Ctx, root: string, ws: string): Promise<Marker> {
  const exe = lipExe(spec)
  rmSync(join(root, SERVER_COMPLETE_MARKER), { force: true })
  rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(ws, { recursive: true })
  const lip = await ensureLip({
    exec: ctx.exec,
    toolsDir: join(ctx.cacheRoot, 'tools'),
    os: ctx.os,
    lipCommand: ctx.opts.lipCommand,
    fetch: ctx.opts.fetch,
    log: ctx.log
  })
  ctx.log(`installing ${serverLabel(spec)} (BDS ${ctx.bdsVersion}) with lip ${lip.version} into ${ws}`)
  for (const args of lipSetupCommands(spec, ctx.bdsVersion)) {
    // lip applies an operation atomically, so a failed one (often a GitHub timeout) can be retried as is.
    for (let attempt = 1; ; attempt++) {
      try {
        await execOk(ctx.exec, lip.command, args, { cwd: ws })
        break
      } catch (err) {
        if (attempt >= LIP_ATTEMPTS) throw err
        ctx.log(`lip ${args[0]!} failed (attempt ${attempt}/${LIP_ATTEMPTS}), retrying: ${(err as Error).message.split('\n')[0]!}`)
      }
    }
  }
  if (!existsSync(join(ws, exe))) throw new Error(`lip setup did not create ${exe} in ${ws}`)

  const state = readLipState(ws)
  const installed = lipBdsVersion(state)
  if (installed !== ctx.bdsVersion) {
    throw new Error(`lip installed BDS ${installed ?? '(unknown version)'} for --game ${lipGameVersion(ctx.bdsVersion)}, not the requested ${ctx.bdsVersion}`)
  }
  const artifacts: ServerArtifact[] = await lipArtifacts(ws, state, ctx.opts.lipCacheDir ?? lipCacheDir(ctx.os))
  for (const m of spec.mods) {
    if (!artifacts.some(a => a.name === m)) throw new Error(`lip did not install mod ${m} (${MOD_PACKAGES[m]})`)
  }
  artifacts.push({
    name: 'lip',
    version: lip.version,
    ...(lip.path !== undefined && existsSync(lip.path) ? { sha256: await sha256File(lip.path) } : {}),
    source: 'github.com/LiteLDev/lip'
  })
  const what = spec.flavor === 'bds' ? 'vanilla BDS' : 'LeviLamina'
  const notes = spec.flavor === 'bds'
    ? ['Windows build of vanilla BDS set up by lip without a loader']
    : [`LeviLamina config overrides written to ${LEVILAMINA_CONFIG_PATH} in each instance; LeviLamina fills in its defaults on first start`]
  let wine: Marker['wine']
  if (spec.runtime === 'wine') {
    const dataDir = ctx.opts.lipDataDir ?? lipDataDir(ctx.os)
    const found = findLipWine(dataDir)
    if (found === undefined) throw new Error(`lip set up ${ws} but its Wine is not in ${join(dataDir, 'wine')}`)
    const r = await execOk(ctx.exec, found.wineBin, ['--version'])
    const version = /wine-?(\S+)/.exec(r.stdout.trim())?.[1] ?? (r.stdout.trim() || undefined)
    wine = { prefix: lipWinePrefix(ws), wineBin: found.wineBin, wineserverBin: found.wineserverBin, ...(version !== undefined ? { version } : {}) }
    artifacts.push({ name: 'wine', ...(version !== undefined ? { version } : {}), sha256: hashTree(found.buildDir), source: found.buildDir })
    notes.push(`Windows build of ${what} run under Wine ${version ?? '?'} (lip's Kron4ek build); WINEPREFIX ${wine.prefix} is shared by all instances`)
  }
  const build = finishBuild({
    spec: { flavor: spec.flavor, mods: spec.mods, runtime: spec.runtime, versions: spec.versions },
    bdsVersion: installed,
    binaryPlatform: 'win',
    exeName: exe,
    artifacts,
    notes
  })
  const marker: Marker = { format: MARKER_FORMAT, build, ...(wine !== undefined ? { wine } : {}) }
  writeMarker(root, marker)
  return marker
}

// ---------------------------------------------------------------------------------------------------------------
// Endstone (pip)
// ---------------------------------------------------------------------------------------------------------------

/** LaunchSpec of Endstone serving `dir`: its CLI (Windows: with the UAC loopback prompt disabled). */
export function endstoneLaunch (dir: string, venv: string, os: HostOs): LaunchSpec {
  const cliArgs = ['-y', '-s', dir, '--no-interactive']
  return {
    command: os === 'windows' ? venvBin(venv, 'python', os) : venvBin(venv, 'endstone', os),
    args: os === 'windows' ? ['-c', ENDSTONE_WINDOWS_LAUNCHER, ...cliArgs] : cliArgs,
    cwd: dir,
    serverProcess: { namePattern: '^bedrock_server(\\.exe)?$' },
    killTree: true
  }
}

async function ensureEndstone (spec: ServerSpec, ctx: Ctx): Promise<InstalledServer> {
  if (spec.runtime !== 'native') throw new Error(`Endstone runs natively only (runtime '${spec.runtime}' is not supported)`)
  const root = serverCacheDir(spec, ctx.bdsVersion, ctx.cacheRoot)
  const ws = join(root, 'server')
  const venv = join(root, 'venv')
  let marker = readMarker(root)
  if (marker === undefined || !existsSync(join(ws, serverExeName(ctx.platform))) || !existsSync(venvBin(venv, 'python', ctx.os))) {
    marker = await installEndstoneServer(spec, ctx, root, ws, venv)
  } else {
    ctx.log(`using cached ${marker.build.label} at ${root}`)
  }
  const os = ctx.os
  return { build: withLoaderConfig(marker.build, spec), pristineDir: ws, launch: dir => endstoneLaunch(dir, venv, os) }
}

async function installEndstoneServer (spec: ServerSpec, ctx: Ctx, root: string, ws: string, venv: string): Promise<Marker> {
  const version = resolveServerSpec(spec).versions.endstone!
  rmSync(join(root, SERVER_COMPLETE_MARKER), { force: true })
  for (const d of [ws, venv, join(root, 'wheels')]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(root, { recursive: true })

  const python = await findPython(ctx.exec, ctx.os, ctx.opts.python)
  ctx.log(`installing endstone ${version} with Python ${python.version} into ${venv}`)
  const { wheel } = await installEndstone({ exec: ctx.exec, os: ctx.os, python, venv, wheelDir: join(root, 'wheels'), version })
  const py = venvBin(venv, 'python', ctx.os)
  const mc = (await execOk(ctx.exec, py, ['-c', 'import endstone; print(endstone.__minecraft_version__)'])).stdout.trim()
  if (!/^\d+\.\d+(\.\d+)?$/.test(mc)) throw new Error(`cannot read the Minecraft version of endstone ${version} (got '${mc}')`)
  const fullMc = Number(mc.split('.')[0]) > 1 ? `1.${mc}` : mc
  if (!(ctx.bdsVersion === fullMc || ctx.bdsVersion.startsWith(fullMc + '.'))) {
    throw new Error(`endstone ${version} runs BDS ${fullMc}, not ${ctx.bdsVersion}`)
  }

  if (ctx.os === 'linux') {
    // bedrock_server is linked against libpython (found through LD_LIBRARY_PATH=LIBDIR, set by Endstone).
    const out = (await execOk(ctx.exec, py, ['-c', LIBPYTHON_CHECK])).stdout.trim().split(/\r?\n/)
    if (out[1] !== '1') {
      const v = python.version.split('.').slice(0, 2).join('.')
      throw new Error(`Endstone needs the shared libpython of Python ${python.version} (${out[0] ?? '?'} is missing; on Debian/Ubuntu: apt-get install libpython${v})`)
    }
  }

  // Pre-place the vanilla build so Endstone does not download its own; version.txt tells it the version.
  const r = await ensureBds(ctx.bdsVersion, { acceptEula: true, cacheRoot: ctx.bdsCacheRoot, platform: ctx.platform, fetch: ctx.opts.fetch })
  copyPristine(r.dir, ws)
  rmSync(join(ws, 'version.txt'), { force: true })
  writeFileSync(join(ws, 'version.txt'), mc)

  // Dependencies are resolved from PyPI at install time: record exactly what was installed.
  const freeze = normalizeFreeze((await execOk(ctx.exec, py, ['-m', 'pip', 'freeze', '--all', '--disable-pip-version-check'])).stdout)
  writeFileSync(join(root, 'pip-freeze.txt'), freeze)
  const bdsSha = bdsZipSha256(r.version, { cacheRoot: ctx.bdsCacheRoot, platform: ctx.platform })
  const artifacts: ServerArtifact[] = [
    { name: 'bds', version: r.version, ...(bdsSha !== undefined ? { sha256: bdsSha } : {}) },
    { name: 'endstone', version, sha256: await sha256File(wheel), source: `pypi:endstone==${version} (${wheel.split(/[\\/]/).at(-1)!})` },
    { name: 'python', version: python.version },
    { name: 'python-deps', sha256: sha256Text(freeze), source: 'pip freeze --all of the venv' }
  ]
  const notes = ctx.os === 'linux'
    ? ['Endstone LD_PRELOADs its bundled mimalloc (and libendstone_runtime.so) into bedrock_server, replacing the allocator']
    : ['Endstone starts bedrock_server.exe with its runtime injected (detours DLL injection); its UAC loopback-exemption prompt is disabled by the bedperf launcher']
  notes.push('Endstone adds a rate limit for NetworkStackLatencyPacket (id 115) to packetlimitconfig.json on start')
  const build = finishBuild({
    spec: { flavor: spec.flavor, mods: spec.mods, runtime: spec.runtime, versions: spec.versions },
    bdsVersion: r.version,
    binaryPlatform: ctx.platform,
    exeName: serverExeName(ctx.platform),
    artifacts,
    ...(ctx.os === 'linux' ? { allocator: 'mimalloc-preload' } : {}),
    notes
  })
  const marker: Marker = { format: MARKER_FORMAT, build, venv }
  writeMarker(root, marker)
  return marker
}

/** Prints `<LIBDIR>/<INSTSONAME>` and `1` when that shared libpython exists, else `0`. */
export const LIBPYTHON_CHECK =
  'import os, sysconfig as s; p = os.path.join(s.get_config_var("LIBDIR") or "", s.get_config_var("INSTSONAME") or ""); ' +
  'print(p); print(1 if os.path.isfile(p) else 0)'

/** Sorted, trimmed `pip freeze` lines (one per package), newline-terminated. */
export function normalizeFreeze (out: string): string {
  return out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#')).sort().join('\n') + '\n'
}

function sha256Text (s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
