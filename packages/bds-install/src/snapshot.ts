import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { BdsInstance } from '@bedperf/core'
import { defaultSnapshotStore } from './platform.ts'
import { renameRetry, tmpSuffix } from './fsutil.ts'

export interface SnapshotFile { path: string, size: number }

/** `<store>/<id>/manifest.json`. The world itself lives in `<store>/<id>/world/`. */
export interface SnapshotManifest {
  id: string
  /** sha256 over the sorted relative paths and bytes of every file (see `hashTree`). */
  hash: string
  createdAt: string
  /** Level name and BDS version of the instance it was taken from. */
  levelName: string
  bdsVersion: string
  files: SnapshotFile[]
  totalBytes: number
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function checkId (id: string): void {
  if (!ID_RE.test(id) || id.includes('..')) throw new Error(`invalid snapshot id '${id}' (use letters, digits, '.', '_', '-')`)
}

/** All regular files under `root`, as '/'-separated relative paths sorted by code unit. */
export function listTree (root: string): SnapshotFile[] {
  const out: SnapshotFile[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push({ path: relative(root, p).split(sep).join('/'), size: statSync(p).size })
    }
  }
  walk(root)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Content hash of a directory tree: sha256 over, for each file in sorted relative-path order,
 * `path NUL size NUL bytes`. Independent of mtimes, absolute location and directory order.
 */
export function hashTree (root: string, files: SnapshotFile[] = listTree(root)): string {
  const h = createHash('sha256')
  for (const f of files) {
    const data = readFileSync(join(root, ...f.path.split('/')))
    h.update(f.path, 'utf8')
    h.update('\0')
    h.update(String(data.length))
    h.update('\0')
    h.update(data)
  }
  return h.digest('hex')
}

export function worldDirOf (instance: Pick<BdsInstance, 'dir' | 'levelName'>): string {
  return join(instance.dir, 'worlds', instance.levelName)
}

export function readSnapshotManifest (id: string, store: string = defaultSnapshotStore()): SnapshotManifest {
  checkId(id)
  const file = join(store, id, 'manifest.json')
  if (!existsSync(file)) throw new Error(`world snapshot '${id}' not found in ${store}`)
  return JSON.parse(readFileSync(file, 'utf8')) as SnapshotManifest
}

/**
 * Copy `worlds/<level>` of a STOPPED instance into the snapshot store. BDS flushes chunks to
 * LevelDB only every few seconds and `save hold` does not flush, so a snapshot of a running
 * server can miss data or be torn.
 */
export async function saveWorldSnapshot (
  instance: Pick<BdsInstance, 'dir' | 'levelName' | 'version'>,
  id: string,
  store: string = defaultSnapshotStore(),
  opts: { overwrite?: boolean } = {}
): Promise<SnapshotManifest> {
  checkId(id)
  const src = worldDirOf(instance)
  if (!existsSync(join(src, 'db'))) throw new Error(`no world at ${src} (did the server run and stop?)`)
  const target = join(store, id)
  if (existsSync(target) && !opts.overwrite) throw new Error(`world snapshot '${id}' already exists in ${store}`)
  await mkdir(store, { recursive: true })
  const tmp = join(store, `.${id}${tmpSuffix()}`)
  try {
    await cp(src, join(tmp, 'world'), { recursive: true })
    const world = join(tmp, 'world')
    const files = listTree(world)
    const manifest: SnapshotManifest = {
      id,
      hash: hashTree(world, files),
      createdAt: new Date().toISOString(),
      levelName: instance.levelName,
      bdsVersion: instance.version,
      files,
      totalBytes: files.reduce((s, f) => s + f.size, 0)
    }
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (existsSync(target)) await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    await renameRetry(tmp, target)
    return manifest
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * Replace `worlds/<level>` of a stopped instance with a snapshot. The world is written under the
 * instance's level name. With `verify` (default true) the stored world is hash-checked first.
 */
export async function restoreWorldSnapshot (
  id: string,
  instance: Pick<BdsInstance, 'dir' | 'levelName'>,
  store: string = defaultSnapshotStore(),
  opts: { verify?: boolean } = {}
): Promise<SnapshotManifest> {
  const manifest = readSnapshotManifest(id, store)
  const src = join(store, id, 'world')
  if (opts.verify !== false) {
    const actual = hashTree(src)
    if (actual !== manifest.hash) throw new Error(`world snapshot '${id}' is corrupt: hash ${actual} != manifest ${manifest.hash}`)
  }
  const dst = worldDirOf(instance)
  await rm(dst, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await mkdir(join(instance.dir, 'worlds'), { recursive: true })
  await cp(src, dst, { recursive: true })
  return manifest
}
