// Step results as a pure function of the recorded envelopes. The engine computes every StepResult
// through `stepFromEnvelopes` on the envelopes it has written so far, so re-deriving a run from its
// samples.jsonl (`recomputeRun`) reproduces steps.json exactly.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  Kinds, RUN_FILES,
  type AgentLinkEvent, type AgentTelemetry, type BenchmarkConfig, type BotFleetStats, type Envelope, type GametimeSample, type InterferenceSample, type ProbeSample, type RunMeta,
  type StepResult, type SysSample
} from '@bedperf/core'
import { evaluateStep } from './criteria.ts'
import { parseConfig } from './config.ts'
import { fileManifest } from './recorder.ts'
import { canonicalJson } from './canonical.ts'

/** Envelope kind of `StepFacts`, written right before `orch.step.end`. */
export const STEP_FACTS_KIND = 'orch.step.facts'
export const REPEAT_START_KIND = 'orch.repeat.start'
export const REPEAT_END_KIND = 'orch.repeat.end'

/**
 * Everything about a step that is not in the sample streams: its identity, the hold bounds, and the
 * decisions taken while it ran (settle, placement verification, crash).
 */
export interface StepFacts {
  repeat: number
  index: number
  players: number
  phase: 'ramp' | 'bisect'
  retry?: boolean
  /** Hold start / end, host epoch ms. */
  startT: number
  endT: number
  /** Probe mark sent at hold start. */
  markLabel: string
  /** Fleet stats period, ms (stats whose interval began before the hold are dropped). */
  statsIntervalMs: number
  /** Tick-counter sampler interval, ms; set when it ran. */
  gametimeIntervalMs?: number
  /** The interference sampler ran. */
  interference?: boolean
  settleSec?: number
  settleCapped?: boolean
  viewsIncomplete?: boolean
  /** Server placement verified at hold start and end (absent without placement). */
  placementVerified?: boolean
  /** Violations found by those verifications. */
  placementIssues?: string[]
  /** The server exited unexpectedly before the step was evaluated. */
  crashed?: string
}

const PROBE_AROUND_MS = 5_000
const SYS_AROUND_MS = 10_000

/** Keep records whose interval began at or after `startT`; all of them when that would drop everything. */
function trimToHold<T> (xs: T[], intervalStart: (x: T) => number, startT: number): T[] {
  const kept = xs.filter(x => intervalStart(x) >= startT)
  return kept.length > 0 ? kept : xs
}

/**
 * The StepResult of one step from the envelopes of its repeat that were written before its facts
 * envelope, in file order. Pure.
 */
export function stepFromEnvelopes (envs: readonly Envelope[], facts: StepFacts, config: Pick<BenchmarkConfig, 'criteria' | 'gates'>): StepResult {
  const { startT, endT } = facts
  let startPos = -1
  for (let i = envs.length - 1; i >= 0; i--) {
    const e = envs[i]!
    const d = e.data as { repeat?: number, index?: number } | null
    if (e.kind === Kinds.stepStart && d?.index === facts.index && d.repeat === facts.repeat) { startPos = i; break }
  }
  let baseline: BotFleetStats | undefined
  for (let i = startPos - 1; i >= 0; i--) {
    if (envs[i]!.kind === Kinds.botStats) { baseline = envs[i]!.data as BotFleetStats; break }
  }
  let markT: number | undefined
  const probe: ProbeSample[] = []
  const probeAround: ProbeSample[] = []
  const sys: SysSample[] = []
  const tickSys: SysSample[] = []
  const bots: BotFleetStats[] = []
  const gametime: GametimeSample[] = []
  const interference: InterferenceSample[] = []
  const agentsLost: AgentLinkEvent[] = []
  const agentTelemetry: Array<{ t: number, data: AgentTelemetry }> = []
  for (let i = Math.max(0, startPos); i < envs.length; i++) {
    const e = envs[i]!
    switch (e.kind) {
      case Kinds.probeMark: {
        const m = e.data as { label?: string, t?: number }
        if (markT === undefined && m.label === facts.markLabel && typeof m.t === 'number') markT = m.t
        break
      }
      case Kinds.probeSample:
        if (e.t >= startT - PROBE_AROUND_MS && e.t <= endT) probeAround.push(e.data as ProbeSample)
        if (e.t >= startT && e.t <= endT) probe.push(e.data as ProbeSample)
        break
      case Kinds.sysSample:
        if (e.t >= startT - SYS_AROUND_MS && e.t <= endT) tickSys.push(e.data as SysSample)
        if (e.t >= startT && e.t <= endT) sys.push(e.data as SysSample)
        break
      case Kinds.botStats:
        if (e.t >= startT && e.t <= endT) bots.push(e.data as BotFleetStats)
        break
      case Kinds.bdsGametime: {
        const g = e.data as GametimeSample
        if (g.t >= startT && g.t <= endT) gametime.push(g)
        break
      }
      case Kinds.sysInterference: {
        const s = e.data as InterferenceSample
        if (s.t - s.intervalMs >= startT && s.t <= endT) interference.push(s)
        break
      }
      case Kinds.agentLink: {
        // lost anywhere from the step start (scale, settle) to the hold end
        const l = e.data as AgentLinkEvent
        if (startPos >= 0 && l?.event === 'lost' && e.t <= endT) agentsLost.push(l)
        break
      }
      case Kinds.agentTelemetry: {
        const a = e.data as AgentTelemetry
        if (typeof a?.foreignCores === 'number' && e.t - (a.intervalMs ?? 0) >= startT && e.t <= endT) agentTelemetry.push({ t: e.t, data: a })
        break
      }
    }
  }
  const evalRes = evaluateStep({
    probe: markT === undefined ? probe : probe.filter(s => s.t - s.windowMs >= markT),
    probeAround,
    sys: trimToHold(sys, s => s.t - s.intervalMs, startT),
    tickSys,
    bots: trimToHold(bots, b => b.t - facts.statsIntervalMs, startT),
    ...(baseline !== undefined ? { botBaseline: baseline } : {}),
    players: facts.players,
    t0: startT,
    t1: endT,
    gametime,
    ...(facts.gametimeIntervalMs !== undefined ? { gametimeIntervalMs: facts.gametimeIntervalMs } : {}),
    ...(facts.interference === true ? { interference } : {}),
    ...(agentsLost.length > 0 ? { agentsLost } : {}),
    // agent foreign load is gated like this machine's: only when the interference gate ran
    ...(facts.interference === true && agentTelemetry.length > 0 ? { agentTelemetry } : {}),
    ...(facts.placementVerified === false ? { extraInvalid: [`placement_mismatch${facts.placementIssues?.length ? `: ${facts.placementIssues.join('; ')}` : ''}`] } : {})
  }, config.criteria, config.gates !== undefined ? { gates: config.gates } : {})
  if (facts.crashed !== undefined) {
    evalRes.pass = false
    evalRes.failReasons.push(facts.crashed)
  }
  const step: StepResult = {
    repeat: facts.repeat,
    index: facts.index,
    players: facts.players,
    phase: facts.phase,
    startT,
    endT,
    ...evalRes
  }
  if (facts.settleSec !== undefined) step.settleSec = facts.settleSec
  if (facts.settleCapped !== undefined) step.settleCapped = facts.settleCapped
  if (facts.viewsIncomplete !== undefined) step.viewsIncomplete = facts.viewsIncomplete
  if (facts.placementVerified !== undefined) step.placementVerified = facts.placementVerified
  return step
}

/** Envelopes of a samples.jsonl text; unparsable lines (e.g. a torn last line) are skipped. */
export function parseSamples (text: string): Envelope[] {
  const out: Envelope[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as Envelope
      if (e !== null && typeof e === 'object' && typeof e.kind === 'string') out.push(e)
    } catch {}
  }
  return out
}

/** Facts for a step of a run that predates `orch.step.facts`, from its `orch.step.end` payload. */
function legacyFacts (s: StepResult): StepFacts {
  return { repeat: s.repeat, index: s.index, players: s.players, phase: s.phase, startT: s.startT, endT: s.endT, markLabel: `step-${s.index}-start`, statsIntervalMs: 1000 }
}

/** Every StepResult of a run, re-derived from its envelopes (pure). */
export function recomputeSteps (envs: readonly Envelope[], config: Pick<BenchmarkConfig, 'criteria' | 'gates'>): { steps: StepResult[], legacy: number } {
  const steps: StepResult[] = []
  let repeatStart = 0
  let legacy = 0
  let pendingFacts = false
  for (let i = 0; i < envs.length; i++) {
    const e = envs[i]!
    if (e.kind === REPEAT_START_KIND) { repeatStart = i; continue }
    if (e.kind === STEP_FACTS_KIND) {
      steps.push(stepFromEnvelopes(envs.slice(repeatStart, i), e.data as StepFacts, config))
      pendingFacts = true
      continue
    }
    if (e.kind === Kinds.stepEnd) {
      if (pendingFacts) { pendingFacts = false; continue }
      legacy++
      steps.push(stepFromEnvelopes(envs.slice(repeatStart, i), legacyFacts(e.data as StepResult), config))
    }
  }
  return { steps, legacy }
}

export interface ManifestCheck {
  /** meta.json has a `files` manifest. */
  present: boolean
  ok: boolean
  /** Files whose sha256 or size differs. */
  changed: string[]
  missing: string[]
  /** Files present now but not in the manifest. */
  extra: string[]
}

/** Compare a run dir against meta.json `files`. */
export async function verifyManifest (runDir: string, meta: Pick<RunMeta, 'files'>): Promise<ManifestCheck> {
  if (meta.files === undefined) return { present: false, ok: true, changed: [], missing: [], extra: [] }
  const now = await fileManifest(runDir)
  const changed: string[] = []
  const missing: string[] = []
  for (const [f, d] of Object.entries(meta.files)) {
    const cur = now[f]
    if (cur === undefined) missing.push(f)
    else if (cur.sha256 !== d.sha256 || cur.bytes !== d.bytes) changed.push(f)
  }
  const extra = Object.keys(now).filter(f => !(f in meta.files!))
  return { present: true, ok: changed.length === 0 && missing.length === 0, changed, missing, extra }
}

export interface RecomputeResult {
  runDir: string
  steps: StepResult[]
  /** `canonicalJson(steps)`. */
  json: string
  /** `canonicalJson` of the current steps.json, or undefined when it is missing. */
  existing?: string
  /** Recomputed steps equal steps.json (after canonicalisation). */
  unchanged: boolean
  /** Steps of runs that predate `orch.step.facts` (recomputed from approximate facts). */
  legacySteps: number
  manifest: ManifestCheck
}

/** Re-derive every StepResult of a run dir from samples.jsonl and config.json and compare with steps.json. */
export async function recomputeRun (runDir: string): Promise<RecomputeResult> {
  const read = (f: string): Promise<string> => readFile(path.join(runDir, f), 'utf8')
  const config = parseConfig(JSON.parse(await read(RUN_FILES.config)), path.join(runDir, RUN_FILES.config))
  const meta = JSON.parse(await read(RUN_FILES.meta)) as RunMeta
  const { steps, legacy } = recomputeSteps(parseSamples(await read(RUN_FILES.samples)), config)
  const json = canonicalJson(steps)
  let existing: string | undefined
  try {
    existing = canonicalJson(JSON.parse(await read(RUN_FILES.steps)))
  } catch {}
  const manifest = await verifyManifest(runDir, meta)
  return { runDir, steps, json, ...(existing !== undefined ? { existing } : {}), unchanged: existing === json, legacySteps: legacy, manifest }
}
