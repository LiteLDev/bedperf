import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Kinds, RUN_FILES } from '@bedperf/core'
import type { BenchmarkConfig, BotFleetStats, Envelope, ProbeSample, RunMeta, RunResult, StepResult, SysSample } from '@bedperf/core'
import type { RunData, StepMarkData } from './types.ts'

async function readJson<T> (file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  return JSON.parse(text) as T
}

/** Like readJson, but a file that does not parse (e.g. truncated by an abort) counts as missing. */
async function readOptionalJson<T> (file: string, name: string, warnings: string[]): Promise<T | undefined> {
  try {
    return await readJson<T>(file)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    warnings.push(`${name} could not be parsed (${err.message}); treated as missing.`)
    return undefined
  }
}

function isObject (v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Minimal shape check for a steps.json entry; aggregate fields are read defensively later. */
function isStepLike (v: unknown): v is StepResult {
  return isObject(v) && typeof v.players === 'number' && typeof v.repeat === 'number' &&
    typeof v.index === 'number' && typeof v.pass === 'boolean'
}

/** A step-end payload that is a full StepResult (not just a mark). */
function isStepResult (v: unknown): v is StepResult {
  return isStepLike(v) && isObject(v.tps)
}

/**
 * Reads a run directory. `config.json` and `meta.json` are required. `result.json` (aborted run)
 * and `steps.json` may be missing; without `steps.json` the step results are taken from
 * `orch.step.end` envelopes that carry a full `StepResult`. `samples.jsonl` is streamed line by
 * line; unknown envelope kinds are counted and skipped, malformed lines are counted.
 */
export async function loadRun (dir: string): Promise<RunData> {
  const config = await readJson<BenchmarkConfig>(join(dir, RUN_FILES.config))
  if (config === undefined) throw new Error(`${RUN_FILES.config} not found in ${dir}`)
  const meta = await readJson<RunMeta>(join(dir, RUN_FILES.meta))
  if (meta === undefined) throw new Error(`${RUN_FILES.meta} not found in ${dir}`)
  const warnings: string[] = []
  const stepsFile = await readOptionalJson<StepResult[]>(join(dir, RUN_FILES.steps), RUN_FILES.steps, warnings)
  const resultFile = await readOptionalJson<RunResult>(join(dir, RUN_FILES.result), RUN_FILES.result, warnings)
  const result = isObject(resultFile) && Array.isArray(resultFile.maxPlayers) ? resultFile : undefined
  if (resultFile !== undefined && result === undefined) warnings.push(`${RUN_FILES.result} has an unexpected shape; treated as missing.`)

  const run: RunData = {
    dir,
    config,
    meta,
    steps: Array.isArray(stepsFile) ? stepsFile.filter(isStepLike) : [],
    result,
    probe: [],
    sys: [],
    bot: [],
    stepMarks: [],
    otherKinds: {},
    badLines: 0,
    warnings
  }
  const endSteps: StepResult[] = []

  const samplesPath = join(dir, RUN_FILES.samples)
  let hasSamples = true
  try {
    await stat(samplesPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    hasSamples = false
  }

  if (hasSamples) {
    const rl = createInterface({ input: createReadStream(samplesPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.trim() === '') continue
      let env: Envelope
      try {
        env = JSON.parse(line) as Envelope
      } catch {
        run.badLines++
        continue
      }
      if (!isObject(env) || typeof env.t !== 'number' || typeof env.kind !== 'string') {
        run.badLines++
        continue
      }
      const { t, kind, data } = env
      switch (kind) {
        case Kinds.probeSample:
          if (isObject(data) && typeof data.tps === 'number') run.probe.push({ t, data: data as unknown as ProbeSample })
          else run.badLines++
          break
        case Kinds.sysSample:
          if (isObject(data) && typeof data.rssBytes === 'number') run.sys.push({ t, data: data as unknown as SysSample })
          else run.badLines++
          break
        case Kinds.botStats:
          if (isObject(data) && typeof data.spawned === 'number') run.bot.push({ t, data: data as unknown as BotFleetStats })
          else run.badLines++
          break
        case Kinds.stepStart:
        case Kinds.stepEnd: {
          const d = (isObject(data) ? data : {}) as StepMarkData
          run.stepMarks.push({ t, edge: kind === Kinds.stepStart ? 'start' : 'end', data: d })
          if (kind === Kinds.stepEnd && isStepResult(data)) endSteps.push(data)
          break
        }
        case Kinds.runStart:
          run.runStartT ??= t
          break
        case Kinds.runEnd:
          run.runEndT = t
          break
        default:
          run.otherKinds[kind] = (run.otherKinds[kind] ?? 0) + 1
      }
    }
  }

  if (run.steps.length === 0 && endSteps.length > 0) run.steps = endSteps
  const byT = (a: { t: number }, b: { t: number }): number => a.t - b.t
  run.probe.sort(byT)
  run.sys.sort(byT)
  run.bot.sort(byT)
  run.stepMarks.sort(byT)
  run.steps.sort((a, b) => a.repeat - b.repeat || a.startT - b.startT || a.index - b.index)
  return run
}
