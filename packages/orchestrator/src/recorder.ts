import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RUN_FILES, envelope, type BenchmarkConfig, type Envelope, type RunMeta, type RunResult, type Source, type StepResult } from '@bedperf/core'
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
    totalMemBytes: os.totalmem(),
    hostname: os.hostname()
  }
}

function json (v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n'
}

/**
 * Writes the `runs/<runId>/` layout (core `RUN_FILES`): config.json, meta.json,
 * samples.jsonl (streamed), steps.json and result.json.
 */
export class RunRecorder {
  readonly runId: string
  readonly dir: string
  readonly meta: RunMeta
  private readonly stream: WriteStream
  private streamError: Error | undefined
  private closed = false
  private readonly now: () => number

  private constructor (runId: string, dir: string, meta: RunMeta, stream: WriteStream, now: () => number) {
    this.runId = runId
    this.dir = dir
    this.meta = meta
    this.stream = stream
    this.now = now
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
    const meta: RunMeta = {
      runId,
      startedAt: new Date(t).toISOString(),
      bdsVersion: opts.config.bdsVersion,
      botVersion: opts.config.botVersion ?? opts.config.bdsVersion,
      host: hostInfo(),
      bedperfVersion: pkg.version,
      colocated: true,
      ...opts.meta
    }
    await writeFile(path.join(dir, RUN_FILES.config), json(opts.config))
    await writeFile(path.join(dir, RUN_FILES.meta), json(meta))
    const stream = createWriteStream(path.join(dir, RUN_FILES.samples), { flags: 'wx' })
    return new RunRecorder(runId, dir, meta, stream, now)
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

  /** Flush and close samples.jsonl, then rewrite meta.json with `finishedAt`. Idempotent. */
  async close (): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => { err != null ? reject(err) : resolve() })
    })
    this.meta.finishedAt = new Date(this.now()).toISOString()
    await writeFile(path.join(this.dir, RUN_FILES.meta), json(this.meta))
    if (this.streamError !== undefined) throw this.streamError
  }
}
