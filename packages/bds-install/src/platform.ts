import { join } from 'node:path'
import { defaultCacheRoot } from '@bedperf/core'

/** BDS build platform, matching `BdsInstance.platform` in @bedperf/core. */
export type Platform = 'win' | 'linux'

/** Platform of the BDS build that runs on this host. */
export function hostPlatform (): Platform {
  return process.platform === 'win32' ? 'win' : 'linux'
}

/** File name of the server executable for a platform. */
export function serverExeName (platform: Platform = hostPlatform()): string {
  return platform === 'win' ? 'bedrock_server.exe' : 'bedrock_server'
}

/**
 * Root of the bedperf cache (parent of `bds/` and `snapshots/`).
 * - `BEDPERF_CACHE_DIR` if set
 * - Windows: `%LOCALAPPDATA%\bedperf\cache`
 * - Linux: `$XDG_CACHE_HOME/bedperf` or `~/.cache/bedperf`
 */
export function cacheBaseDir (): string {
  return defaultCacheRoot()
}

/** Root of the BDS download cache. Same layout as `bdsCacheRoot()` in @bedperf/testkit. */
export function defaultBdsCacheRoot (): string {
  return join(cacheBaseDir(), 'bds')
}

/** Default world snapshot store. */
export function defaultSnapshotStore (): string {
  return join(cacheBaseDir(), 'snapshots')
}

/**
 * Directory name of a version inside the cache root. Builds for the host platform use the bare
 * version (compatible with testkit); a foreign-platform build gets a `-win` / `-linux` suffix.
 */
export function versionDirName (version: string, platform: Platform = hostPlatform()): string {
  return platform === hostPlatform() ? version : `${version}-${platform}`
}

/** Absolute path of the extracted, pristine build of `version` in `cacheRoot`. */
export function pristineDirOf (version: string, opts: { cacheRoot?: string, platform?: Platform } = {}): string {
  return join(opts.cacheRoot ?? defaultBdsCacheRoot(), versionDirName(version, opts.platform))
}
