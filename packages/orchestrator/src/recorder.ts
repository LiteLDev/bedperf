import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  RUN_FILES, Scrubber, envelope, harnessInfo, machineInfo, sha256Json,
  type BenchmarkConfig, type Envelope, type FileDigest, type HarnessInfo, type MachineInfo, type RunMeta, type RunResult, type Source, type StepResult
} from '@bedperf/core'
import pkg from '../package.json' with { type: 'json' }

export interface RunRecorderOptions {
  /** Parent directory; the run lands in `<runsDir>/<runId>/`. */
  runsDir: string
  config: BenchmarkConfig
  /** Clock for runId and `startedAt`. */
  now?: () => number
  /** Override the generated runId (`<ISO timestamp>_<config name>`). */
  runId?: string
  /** Extra / overriding meta fields (colocated, bedbooCommit, ...). */
  meta?: Partial<Omit<RunMeta, 'runId' | 'startedAt'>>
  /** Machine / harness provenance. Default: computed once per process (`machineInfo`, `harnessInfo`). */
  provenance?: () => Promise<{ machine: MachineInfo, harness: HarnessInfo }>
  /** Scrubber for meta.json and config.json. Default: `<run>` plus the default roots, user and host. */
  scrubber?: (runDir: string) => Scrubber
}

let cachedProvenance: Promise<{ machine: MachineInfo, harness: HarnessInfo }> | undefined

/** Machine and harness provenance of this process, computed once (spawns git and, on Windows, PowerShell). */
export function defaultProvenance (): Promise<{ machine: MachineInfo, harness: HarnessInfo }> {
  cachedProvenance ??= Promise.all([machineInfo(), harnessInfo({ version: pkg.version })])
    .then(([machine, harness]) => ({ machine, harness }))
  return cachedProvenance
}

/** Files of the run dir that `meta.files` never lists: meta.json describes the others, report.html is derived. */
const UNLISTED = new Set<string>([RUN_FILES.meta, RUN_FILES.report])

async function digestFile (file: string): Promise<FileDigest> {
  const h = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { sha256: h.digest('hex'), bytes }
}

/** sha256 and size of every regular file under `dir` except top-level meta.json and report.html, sorted by path. */
export async function fileManifest (dir: string): Promise<Record<string, FileDigest>> {
  const rels: string[] = []
  const walk = async (sub: string): Promise<void> => {
    for (const e of await readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub === '' ? e.name : `${sub}/${e.name}`
      if (e.isDirectory()) await walk(rel)
      else if (e.isFile() && !UNLISTED.has(rel)) rels.push(rel)
    }
  }
  await walk('')
  rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, FileDigest> = {}
  for (const rel of rels) out[rel] = await digestFile(path.join(dir, ...rel.split('/')))
  return out
}

/** `2026-11-16T10-00-00-000Z_standard` — sortable, filesystem-safe. */
export function makeRunId (t: number, name: string): string {
  const ts = new Date(t).toISOString().replace(/[:.]/g, '-')
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'run'
  return `${ts}_${safe}`
}

export function hostInfo (): RunMeta['host'] {
  const cpus = os.cpus()
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpus.length,
    totalMemBytes: os.totalmem()
  }
}

/** `configSha256`, or nothing for a config canonicalJson rejects (NaN / Infinity): provenance never aborts a run. */
function configHash (config: BenchmarkConfig): { configSha256?: string } {
  try {
    return { configSha256: sha256Json(config) }
  } catch {
    return {}
  }
}

/** Scrubbed meta; `runId` is kept as is, since it names the run dir (a host-named config would otherwise break it). */
function scrubMeta (scrubber: Scrubber, meta: RunMeta): RunMeta {
  return { ...scrubber.scrub(meta), runId: meta.runId }
}

function json (v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n'
}

/**
 * Writes the `runs/<runId>/` layout (core `RUN_FILES`): config.json, meta.json,
 * samples.jsonl (streamed), steps.json and result.json.
 *
 * meta.json and config.json go through a `Scrubber` (no absolute paths, user or host names). meta.json carries
 * provenance: `configSha256`, `machine`, `harness` and, after `close()`, the `files` manifest. Raw logs
 * (samples.jsonl, bds*.log) are written as they come and are NOT scrubbed.
 */
export class RunRecorder {
  readonly runId: string
  readonly dir: string
  readonly meta: RunMeta
  private readonly stream: WriteStream
  private streamError: Error | undefined
  private closed = false
  private readonly now: () => number
  private readonly scrubber: Scrubber

  private constructor (runId: string, dir: string, meta: RunMeta, stream: WriteStream, now: () => number, scrubber: Scrubber) {
    this.runId = runId
    this.dir = dir
    this.meta = meta
    this.stream = stream
    this.now = now
    this.scrubber = scrubber
    stream.on('error', err => { this.streamError ??= err })
  }

  static async create (opts: RunRecorderOptions): Promise<RunRecorder> {
    const now = opts.now ?? Date.now
    const t = now()
    const base = opts.runId ?? makeRunId(t, opts.config.name)
    await mkdir(opts.runsDir, { recursive: true })
    let runId = base
    let dir = path.join(opts.runsDir, runId)
    for (let i = 2; ; i++) {
      try {
        await mkdir(dir)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i > 1000) throw err
        runId = `${base}-${i}`
        dir = path.join(opts.runsDir, runId)
      }
    }
    const scrubber = opts.scrubber?.(dir) ?? new Scrubber({ '<run>': dir })
    const config = scrubber.scrub(opts.config)
    const { machine, harness } = await (opts.provenance ?? defaultProvenance)()
    const meta: RunMeta = {
      runId,
      startedAt: new Date(t).toISOString(),
      bdsVersion: opts.config.bdsVersion,
      botVersion: opts.config.botVersion ?? opts.config.bdsVersion,
      host: hostInfo(),
      bedperfVersion: pkg.version,
      colocated: true,
      ...configHash(config),
      machine,
      harness,
      ...opts.meta
    }
    await writeFile(path.join(dir, RUN_FILES.config), json(config))
    await writeFile(path.join(dir, RUN_FILES.meta), json(scrubMeta(scrubber, meta)))
    const stream = createWriteStream(path.join(dir, RUN_FILES.samples), { flags: 'wx' })
    return new RunRecorder(runId, dir, meta, stream, now, scrubber)
  }

  /** Append one envelope to samples.jsonl. Ignored after `close()`. */
  write (env: Envelope): void {
    if (this.closed) return
    this.stream.write(JSON.stringify(env) + '\n')
  }

  /** Wrap `data` in an envelope (t defaults to the recorder clock) and append it. */
  record<K extends string, D> (src: Source, kind: K, data: D, t: number = this.now()): void {
    this.write(envelope(src, kind, data, t))
  }

  async writeSteps (steps: readonly StepResult[]): Promise<void> {
    await writeFile(path.join(this.dir, RUN_FILES.steps), json(steps))
  }

  async writeResult (result: RunResult): Promise<void> {
    await writeFile(path.join(this.dir, RUN_FILES.result), json(result))
  }

  /**
   * Flush and close samples.jsonl, then rewrite meta.json with `finishedAt` and the `files` manifest.
   * Idempotent. Files written into the run dir after this (report.html) are not in the manifest.
   */
  async close (): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => { err != null ? reject(err) : resolve() })
    })
    this.meta.finishedAt = new Date(this.now()).toISOString()
    try {
      this.meta.files = await fileManifest(this.dir)
    } catch {
      // A manifest is best effort: never lose finishedAt over it.
    }
    await writeFile(path.join(this.dir, RUN_FILES.meta), json(scrubMeta(this.scrubber, this.meta)))
    if (this.streamError !== undefined) throw this.streamError
  }
}
