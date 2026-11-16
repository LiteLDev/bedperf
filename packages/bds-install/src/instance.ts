import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BdsInstance, ServerProperties } from '@bedperf/core'
import { hostPlatform, pristineDirOf, serverExeName, type Platform } from './platform.ts'
import { instancePropertyLayers, mergeServerProperties, type PresetName } from './properties.ts'
import { restoreWorldSnapshot } from './snapshot.ts'

/** Marker written into every instance dir; `destroyInstance` refuses dirs without it. */
export const INSTANCE_MARKER = '.bedperf-instance.json'

// Large read-only parts are hard-linked to save ~300 MB and seconds per instance; anything the
// server may write (properties, config, worlds, json lists) is copied. Never write through a link:
// unlink the file first.
const LINKABLE = new Set(['bedrock_server.exe', 'bedrock_server', 'behavior_packs', 'resource_packs', 'definitions', 'data'])

function linkTree (src: string, dst: string): void {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src)) linkTree(join(src, e), join(dst, e))
    return
  }
  try { linkSync(src, dst) } catch { cpSync(src, dst) }
}

/** Copy a pristine build into `dir` (which must not exist or be empty). */
export function copyPristine (pristine: string, dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`instance dir ${dir} is not empty`)
  mkdirSync(dir, { recursive: true })
  for (const e of readdirSync(pristine)) {
    if (LINKABLE.has(e)) linkTree(join(pristine, e), join(dir, e))
    else cpSync(join(pristine, e), join(dir, e), { recursive: true })
  }
}

/** Write a file, unlinking it first so a hard link to the pristine cache is never written through. */
function replaceFile (file: string, data: string): void {
  rmSync(file, { force: true })
  writeFileSync(file, data)
}

interface PackManifest { header: { uuid: string, version: number[] | string, name?: string } }

/**
 * Install a behavior pack directory (containing manifest.json) into the instance and enable it
 * on `levelName` via `worlds/<level>/world_behavior_packs.json`. Works before the world exists;
 * re-installing the same pack uuid replaces the entry.
 */
export function installBehaviorPack (dir: string, packDir: string, levelName: string): { packId: string, version: number[] } {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as PackManifest
  const uuid = manifest.header?.uuid
  if (typeof uuid !== 'string') throw new Error(`${packDir}/manifest.json has no header.uuid`)
  const version = typeof manifest.header.version === 'string'
    ? manifest.header.version.split('.').map(Number)
    : manifest.header.version
  if (!Array.isArray(version) || version.length !== 3 || !version.every(Number.isInteger)) {
    throw new Error(`${packDir}/manifest.json: header.version must be [x, y, z]`)
  }
  const target = join(dir, 'behavior_packs', `bedperf_${uuid.slice(0, 8)}`)
  rmSync(target, { recursive: true, force: true })
  cpSync(packDir, target, { recursive: true })

  const worldDir = join(dir, 'worlds', levelName)
  mkdirSync(worldDir, { recursive: true })
  const listFile = join(worldDir, 'world_behavior_packs.json')
  const list = existsSync(listFile)
    ? (JSON.parse(readFileSync(listFile, 'utf8')) as Array<{ pack_id: string, version: number[] }>)
    : []
  const next = list.filter(e => e.pack_id !== uuid)
  next.push({ pack_id: uuid, version })
  replaceFile(listFile, JSON.stringify(next, null, 2))
  return { packId: uuid, version }
}

export interface CreateInstanceOptions {
  /** Extracted version in the cache (run `ensureBds` first). */
  version: string
  platform?: Platform
  cacheRoot?: string
  /** Use this pristine dir instead of `<cacheRoot>/<version>`. */
  pristineDir?: string
  /** Instance dir; must not exist or be empty. Default: a fresh `bedperf-bds-*` dir under the OS temp dir. */
  dir?: string
  /** IPv4 port. */
  port: number
  /** IPv6 port. Default port + 1. */
  portV6?: number
  /** Default 'bedperf'. */
  levelName?: string
  /** Preset names or property objects, applied in order after REQUIRED_BOT_PROPERTIES. */
  presets?: Array<PresetName | ServerProperties>
  /** Overrides, applied after presets. */
  properties?: ServerProperties
  /** Behavior pack dirs (each with manifest.json) to install and enable. */
  behaviorPacks?: string[]
  /** Restore this world snapshot before installing packs. */
  worldSnapshot?: { id: string, store?: string, verify?: boolean }
}

/**
 * Create a runnable instance from a pristine build. server.properties is the pristine file
 * merged with, in order: REQUIRED_BOT_PROPERTIES < presets < properties < port/portV6/levelName.
 */
export async function createInstance (opts: CreateInstanceOptions): Promise<BdsInstance> {
  const platform = opts.platform ?? hostPlatform()
  const pristine = opts.pristineDir ?? pristineDirOf(opts.version, { cacheRoot: opts.cacheRoot, platform })
  if (!existsSync(join(pristine, serverExeName(platform)))) {
    throw new Error(`BDS ${opts.version} (${platform}) is not extracted at ${pristine}; run ensureBds first`)
  }
  if (opts.dir !== undefined && existsSync(opts.dir) && readdirSync(opts.dir).length > 0) {
    throw new Error(`instance dir ${opts.dir} is not empty`)
  }
  const dir = resolve(opts.dir ?? mkdtempSync(join(tmpdir(), 'bedperf-bds-')))
  const instance: BdsInstance = {
    dir,
    version: opts.version,
    platform,
    port: opts.port,
    portV6: opts.portV6 ?? opts.port + 1,
    levelName: opts.levelName ?? 'bedperf'
  }
  try {
    copyPristine(pristine, dir)
    writeFileSync(join(dir, INSTANCE_MARKER), JSON.stringify({ ...instance, pristine, createdAt: new Date().toISOString() }, null, 2))

    const propsFile = join(dir, 'server.properties')
    const base = existsSync(propsFile) ? readFileSync(propsFile, 'utf8') : ''
    replaceFile(propsFile, mergeServerProperties(base, ...instancePropertyLayers({
      presets: opts.presets,
      properties: opts.properties,
      port: instance.port,
      portV6: instance.portV6,
      levelName: instance.levelName
    })))

    if (opts.worldSnapshot) {
      await restoreWorldSnapshot(opts.worldSnapshot.id, instance, opts.worldSnapshot.store, { verify: opts.worldSnapshot.verify })
    }
    for (const p of opts.behaviorPacks ?? []) installBehaviorPack(dir, p, instance.levelName)
  } catch (err) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw err
  }
  return instance
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'])

/**
 * Delete an instance dir created by `createInstance`. Retries while Windows still holds files
 * of a just-exited server (EBUSY/EPERM). Refuses dirs without the instance marker.
 */
export async function destroyInstance (instance: Pick<BdsInstance, 'dir'>, opts: { attempts?: number, delayMs?: number } = {}): Promise<void> {
  const dir = resolve(instance.dir)
  if (!existsSync(dir)) return
  if (!existsSync(join(dir, INSTANCE_MARKER))) {
    throw new Error(`refusing to delete ${dir}: not a bedperf instance (no ${INSTANCE_MARKER})`)
  }
  const attempts = opts.attempts ?? 20
  for (let i = 1; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (i >= attempts || !RETRY_CODES.has(code)) throw err
      await new Promise(r => setTimeout(r, opts.delayMs ?? 500))
    }
  }
}
