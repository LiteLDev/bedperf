// `bedperf analyze <runDir> [--write]`: re-derive every step of a run from its raw samples and check
// the result against steps.json and the run dir against meta.json's file manifest (R10).
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RUN_FILES, type RunMeta, type StepResult } from '@bedperf/core'
import { canonicalJson, recomputeRun } from '@bedperf/orchestrator'

export interface AnalyzeResult {
  /** `unchanged`: recomputed steps equal steps.json; `differs`: they do not; `rewritten`: they did not and steps.json was rewritten. */
  verdict: 'unchanged' | 'differs' | 'rewritten'
  /** Steps (`repeat/index`) whose recomputed result differs. */
  differing: string[]
  manifestOk: boolean
  lines: string[]
  /** 0 when unchanged (or rewritten) and the manifest matches, else 1. */
  exitCode: number
}

function stepKey (s: Pick<StepResult, 'repeat' | 'index'>): string {
  return `${s.repeat}/${s.index}`
}

export async function analyzeCommand (runDir: string, opts: { write?: boolean } = {}): Promise<AnalyzeResult> {
  const r = await recomputeRun(runDir)
  const lines: string[] = []
  const differing: string[] = []
  if (!r.unchanged) {
    let old: StepResult[] = []
    try { old = JSON.parse(await readFile(path.join(runDir, RUN_FILES.steps), 'utf8')) as StepResult[] } catch {}
    const byKey = new Map(old.map(s => [stepKey(s), canonicalJson(s)]))
    for (const s of r.steps) if (byKey.get(stepKey(s)) !== canonicalJson(s)) differing.push(stepKey(s))
    for (const k of byKey.keys()) if (!r.steps.some(s => stepKey(s) === k)) differing.push(k)
  }
  lines.push(`${r.steps.length} steps recomputed from ${RUN_FILES.samples}${r.legacySteps > 0 ? ` (${r.legacySteps} from a run without step facts: approximate)` : ''}`)
  const m = r.manifest
  if (!m.present) lines.push('file manifest: none in meta.json')
  else if (m.ok) lines.push('file manifest: ok')
  else lines.push(`file manifest: MISMATCH${m.changed.length > 0 ? ` changed ${m.changed.join(', ')}` : ''}${m.missing.length > 0 ? ` missing ${m.missing.join(', ')}` : ''}`)
  let verdict: AnalyzeResult['verdict'] = r.unchanged ? 'unchanged' : 'differs'
  if (!r.unchanged) lines.push(`differs: ${r.existing === undefined ? `no ${RUN_FILES.steps}` : `steps ${differing.join(', ')}`}`)
  if (!r.unchanged && opts.write === true) {
    await writeFile(path.join(runDir, RUN_FILES.steps), r.json)
    // Keep the manifest describing the files as they now are.
    const metaPath = path.join(runDir, RUN_FILES.meta)
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    if (meta.files !== undefined) {
      const buf = Buffer.from(r.json, 'utf8')
      meta.files[RUN_FILES.steps] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
      await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')
    }
    verdict = 'rewritten'
    lines.push(`rewrote ${RUN_FILES.steps}`)
  }
  lines.push(verdict)
  const manifestOk = !m.present || m.ok || (verdict === 'rewritten' && m.changed.every(f => f === RUN_FILES.steps) && m.missing.length === 0)
  return { verdict, differing, manifestOk, lines, exitCode: verdict !== 'differs' && manifestOk ? 0 : 1 }
}
