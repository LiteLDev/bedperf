import { sha256Json } from './provenance.ts'

/**
 * Server implementations bedperf can benchmark.
 * - `bds`: vanilla Bedrock Dedicated Server.
 * - `levilamina`: BDS + LeviLamina mod loader (Windows build; on Linux via Wine), installed with `lip`.
 * - `endstone`: BDS + Endstone plugin loader (Windows and Linux), installed with pip.
 */
export type ServerFlavor = 'bds' | 'levilamina' | 'endstone'
export const SERVER_FLAVORS: readonly ServerFlavor[] = ['bds', 'levilamina', 'endstone']

/** How the server binary runs on the host. `wine`: a Windows build under Wine on Linux. */
export type ServerRuntime = 'native' | 'wine'
export const SERVER_RUNTIMES: readonly ServerRuntime[] = ['native', 'wine']

/** Mods (LeviLamina) known to bedperf. */
export type ServerMod = 'levioptimize'
export const SERVER_MODS: readonly ServerMod[] = ['levioptimize']

/** Pinned component versions. Absent fields fall back to `DEFAULT_SERVER_VERSIONS`. */
export interface ServerVersions {
  /** LeviLamina release, e.g. '26.60.7'. */
  levilamina?: string
  /** LeviOptimize release, e.g. '0.18.0'. */
  levioptimize?: string
  /** Endstone PyPI release, e.g. '0.11.15'. */
  endstone?: string
}

/** BenchmarkConfig.server: which server implementation to run. Absent means vanilla BDS, native. */
export interface ServerSpec {
  flavor: ServerFlavor
  /** Mods to install on top of the loader (LeviLamina only). Sorted, no duplicates. */
  mods: ServerMod[]
  runtime: ServerRuntime
  versions: ServerVersions
  /**
   * Loader config overrides, deep-merged over bedperf's benchmark-neutral defaults (see
   * `NEUTRAL_LOADER_CONFIG`). The effective config is recorded in meta.server.loaderConfig.
   */
  loaderConfig?: Record<string, unknown>
}

/**
 * Component versions bedperf pins by default. BDS 1.26.60.6 is the only build every flavor supports
 * (LeviLamina 26.60.x pins bds 1.26.60; Endstone 0.11.15 added 1.26.60).
 */
export const DEFAULT_SERVER_VERSIONS: Required<ServerVersions> = {
  levilamina: '26.60.7',
  levioptimize: '0.18.0',
  endstone: '0.11.15'
}

/** BDS build a modded flavor needs, by flavor. Vanilla BDS has no constraint. */
export const FLAVOR_BDS_VERSION: Record<Exclude<ServerFlavor, 'bds'>, string> = {
  levilamina: '1.26.60.6',
  endstone: '1.26.60.6'
}

/** Named server presets (`--server <name>`). */
export const SERVER_PRESETS = {
  bds: { flavor: 'bds', mods: [], runtime: 'native', versions: {} },
  levilamina: { flavor: 'levilamina', mods: [], runtime: 'native', versions: {} },
  'levilamina-levioptimize': { flavor: 'levilamina', mods: ['levioptimize'], runtime: 'native', versions: {} },
  endstone: { flavor: 'endstone', mods: [], runtime: 'native', versions: {} },
  'bds-wine': { flavor: 'bds', mods: [], runtime: 'wine', versions: {} },
  'levilamina-wine': { flavor: 'levilamina', mods: [], runtime: 'wine', versions: {} },
  'levilamina-levioptimize-wine': { flavor: 'levilamina', mods: ['levioptimize'], runtime: 'wine', versions: {} }
} as const satisfies Record<string, ServerSpec>
export type ServerPresetName = keyof typeof SERVER_PRESETS
export const SERVER_PRESET_NAMES = Object.keys(SERVER_PRESETS) as ServerPresetName[]

export const DEFAULT_SERVER_SPEC: ServerSpec = { flavor: 'bds', mods: [], runtime: 'native', versions: {} }

/**
 * LeviLamina config overrides that keep the loader from changing what is measured or phoning home:
 * telemetry and crash uploads off, per-IP connection throttling off (all bots of an agent share an IP).
 * Paths are keys of LeviLamina's `mods/LeviLamina/config/Config.json` (config version 43, LeviLamina 26.60.7).
 */
export const NEUTRAL_LOADER_CONFIG: Record<ServerFlavor, Record<string, unknown>> = {
  bds: {},
  levilamina: {
    modules: {
      crashLogger: { uploadToSentry: false }
    },
    targeted: {
      enableStatistics: false,
      vulnerabilityFixes: { limitIPFrequency: false }
    }
  },
  endstone: {}
}

/** Fill defaults: pinned versions for the flavor's components, sorted unique mods. */
export function resolveServerSpec (spec: ServerSpec | undefined): ServerSpec & { versions: ServerVersions } {
  const s = spec ?? DEFAULT_SERVER_SPEC
  const versions: ServerVersions = {}
  if (s.flavor === 'levilamina') versions.levilamina = s.versions.levilamina ?? DEFAULT_SERVER_VERSIONS.levilamina
  if (s.mods.includes('levioptimize')) versions.levioptimize = s.versions.levioptimize ?? DEFAULT_SERVER_VERSIONS.levioptimize
  if (s.flavor === 'endstone') versions.endstone = s.versions.endstone ?? DEFAULT_SERVER_VERSIONS.endstone
  const out: ServerSpec = { flavor: s.flavor, mods: [...new Set(s.mods)].sort(), runtime: s.runtime, versions }
  if (s.loaderConfig !== undefined) out.loaderConfig = s.loaderConfig
  return out
}

/** Short human label, e.g. `levilamina+levioptimize (wine)`. */
export function serverLabel (spec: ServerSpec | undefined): string {
  const s = spec ?? DEFAULT_SERVER_SPEC
  return [s.flavor, ...s.mods].join('+') + (s.runtime === 'wine' ? ' (wine)' : '')
}

/** The BDS version a spec must run, given the config's `bdsVersion` request (`latest`, `preview` or exact). */
export function bdsVersionFor (spec: ServerSpec | undefined, requested: string): string {
  if (spec === undefined || spec.flavor === 'bds') return requested
  return /^\d+\.\d+\.\d+\.\d+$/.test(requested) ? requested : FLAVOR_BDS_VERSION[spec.flavor]
}

/** Stable identity of a resolved spec (without loaderConfig, which is recorded separately). */
export function serverSpecSha256 (spec: ServerSpec): string {
  const r = resolveServerSpec(spec)
  return sha256Json({ flavor: r.flavor, mods: r.mods, runtime: r.runtime, versions: r.versions })
}

/**
 * How to start an installed server. Produced by @bedperf/bds-install for an instance, consumed by
 * @bedperf/bds-process. `command` may be a launcher (lip, wine, python/endstone); the process that
 * actually runs the game is found among its descendants by `serverProcess`.
 */
export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
  /** Extra environment, merged over process.env. */
  env?: Record<string, string>
  /**
   * Identifies the game process: the first descendant (or the spawned process itself) whose image
   * name (basename, case-insensitive; Linux: `comm` or the basename of argv[0]) matches `namePattern`
   * (a RegExp source).
   */
  serverProcess: { namePattern: string }
  /** Helper processes (not descendants) that belong to the server, e.g. `^wineserver$`. RegExp sources. */
  auxProcessPatterns?: string[]
  /** Kill the whole process tree on kill/stop timeout (always true for launchers). */
  killTree: boolean
  /** Command sent on stdin for a graceful stop. Default `stop`. */
  stopCommand?: string
  /** Wine only: WINEPREFIX and the wine binary used (for `wineserver -k` cleanup and provenance). */
  wine?: { prefix: string, wineBin: string, wineserverBin?: string, version?: string }
}

/** One input artifact of a server build, hashed for provenance. */
export interface ServerArtifact {
  /** e.g. `bds`, `levilamina`, `levioptimize`, `endstone`, `lip`, `wine`. */
  name: string
  version?: string
  /** sha256 of the downloaded archive / wheel, or `hashTree` of the installed directory. */
  sha256?: string
  /** Where it came from (URL or package reference); scrubbed before writing. */
  source?: string
}

/** Description of an installed server build (written to meta.server). */
export interface ServerBuildInfo {
  spec: ServerSpec
  /** `serverLabel(spec)`. */
  label: string
  /** sha256 of the resolved spec. */
  specSha256: string
  bdsVersion: string
  /** Platform of the server binary (a `win` build may run on a Linux host under Wine). */
  binaryPlatform: 'win' | 'linux'
  /** Executable inside the instance dir that runs the game, e.g. `bedrock_server_mod.exe`. */
  exeName: string
  artifacts: ServerArtifact[]
  /** sha256Json(artifacts sorted by name) — the build identity used for comparability. */
  buildSha256: string
  /** Memory allocator the game runs with, when the launcher changes it (e.g. `mimalloc-preload`). Absent: the binary's own. */
  allocator?: string
  /** Effective loader config written into the instance (after neutral defaults and overrides). */
  loaderConfig?: Record<string, unknown>
  /** Things a reader of results must know (e.g. "Endstone preloads mimalloc on Linux"). */
  notes: string[]
}

/** sha256 over artifacts sorted by name (order-independent build identity). */
export function serverBuildSha256 (artifacts: readonly ServerArtifact[]): string {
  const sorted = [...artifacts].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return sha256Json(sorted.map(a => ({ name: a.name, version: a.version, sha256: a.sha256 })))
}
