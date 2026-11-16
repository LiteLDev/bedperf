import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { crc32 } from 'node:zlib'
import { inflateSync } from 'fflate'

export interface ZipEntry {
  /** Path inside the archive, '/'-separated. Directories end with '/'. */
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  /** Unix permission bits when the archive was made on a Unix host, else undefined. */
  mode: number | undefined
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

/** Read the central directory of a zip held in memory. Zip64 archives are not supported. */
export function listZipEntries (zip: Uint8Array): ZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)')
  const count = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported')
  const dec = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== CDH_SIG) throw new Error(`corrupt zip central directory at entry ${i}`)
    const madeBy = dv.getUint16(p + 4, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const external = dv.getUint32(p + 38, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const localHeaderOffset = dv.getUint32(p + 42, true)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('zip64 archives are not supported')
    }
    const unixMode = (external >>> 16) & 0o7777
    entries.push({
      name: dec.decode(zip.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/'),
      method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true),
      compressedSize,
      size,
      mode: (madeBy >>> 8) === 3 && unixMode !== 0 ? unixMode : undefined,
      localHeaderOffset
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Decompress one entry and verify its CRC-32. */
export function readZipEntry (zip: Uint8Array, e: ZipEntry): Uint8Array {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const o = e.localHeaderOffset
  if (o + 30 > zip.length || dv.getUint32(o, true) !== LFH_SIG) throw new Error(`corrupt local header for ${e.name}`)
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true)
  const raw = zip.subarray(start, start + e.compressedSize)
  if (raw.length !== e.compressedSize) throw new Error(`truncated zip entry ${e.name}`)
  let data: Uint8Array
  if (e.method === 0) data = raw
  else if (e.method === 8) data = inflateSync(raw, { out: new Uint8Array(e.size) })
  else throw new Error(`unsupported compression method ${e.method} for ${e.name}`)
  if (data.length !== e.size) throw new Error(`size mismatch for ${e.name}: ${data.length} != ${e.size}`)
  if (crc32(data) >>> 0 !== e.crc >>> 0) throw new Error(`CRC mismatch for ${e.name}`)
  return data
}

/** Names of files that must be executable after extraction even if the zip lacks Unix modes. */
const ALWAYS_EXEC = new Set(['bedrock_server'])

export interface ExtractResult { files: number, bytes: number }

/**
 * Extract a zip (path or bytes) into `destDir` with fflate, one entry in memory at a time.
 * Rejects entries escaping `destDir`. On non-Windows hosts, Unix exec bits are restored, and
 * `bedrock_server` is always made executable.
 */
export async function extractZip (zip: string | Uint8Array, destDir: string): Promise<ExtractResult> {
  const bytes = typeof zip === 'string' ? await readFile(zip) : zip
  const root = resolve(destDir)
  mkdirSync(root, { recursive: true })
  const setModes = process.platform !== 'win32'
  let files = 0
  let total = 0
  for (const e of listZipEntries(bytes)) {
    const target = resolve(root, e.name)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip entry escapes the target dir: ${e.name}`)
    if (e.name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue }
    mkdirSync(dirname(target), { recursive: true })
    const data = readZipEntry(bytes, e)
    writeFileSync(target, data)
    if (setModes) {
      const base = e.name.slice(e.name.lastIndexOf('/') + 1)
      let mode = e.mode !== undefined ? e.mode & 0o777 : undefined
      if (ALWAYS_EXEC.has(base)) mode = (mode ?? 0o644) | 0o755
      if (mode !== undefined) chmodSync(target, mode)
    }
    files++
    total += data.length
    // Large archives: let timers and I/O callbacks run between entries.
    await new Promise<void>(r => setImmediate(r))
  }
  return { files, bytes: total }
}
