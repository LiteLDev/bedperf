import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RUN_FILES } from '@bedperf/core'
import { analyze } from './analyze.ts'
import { compareRuns, renderCompareHtml } from './compare.ts'
import type { CompareOptions } from './compare.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'
import { compareMatrix, renderMatrixHtml } from './matrix.ts'
import type { MatrixComparison } from './matrix.ts'

/** Loads and analyses `runDir` and writes `report.html` into it. Returns the file path. */
export async function writeReport (runDir: string): Promise<string> {
  const html = renderHtml(analyze(await loadRun(runDir)))
  const out = join(runDir, RUN_FILES.report)
  await writeFile(out, html, 'utf8')
  return out
}

/**
 * Writes an HTML comparison of run B (`dirB`) against baseline A (`dirA`) to `outFile`. Throws
 * `IncomparableRunsError` (and writes nothing) when the runs are not comparable, unless
 * `opts.force` is set.
 */
export async function writeCompare (dirA: string, dirB: string, outFile: string, opts: CompareOptions = {}): Promise<string> {
  const [a, b] = await Promise.all([loadRun(dirA), loadRun(dirB)])
  const html = renderCompareHtml(compareRuns(analyze(a), analyze(b), opts))
  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, html, 'utf8')
  return outFile
}

/**
 * Writes an HTML matrix comparison of N ≥ 2 runs to `outFile` (pairwise verdicts, ranking).
 * Throws `IncomparableRunsError` (and writes nothing) when a pair is not comparable, unless
 * `opts.force` is set.
 */
export async function writeCompareMatrix (dirs: readonly string[], outFile: string, opts: CompareOptions = {}): Promise<{ file: string, comparison: MatrixComparison }> {
  const runs = await Promise.all(dirs.map(loadRun))
  const comparison = compareMatrix(runs.map(analyze), opts)
  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, renderMatrixHtml(comparison), 'utf8')
  return { file: outFile, comparison }
}
