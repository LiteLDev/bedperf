import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RUN_FILES } from '@bedperf/core'
import { analyze } from './analyze.ts'
import { compareRuns, renderCompareHtml } from './compare.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'

/** Loads and analyses `runDir` and writes `report.html` into it. Returns the file path. */
export async function writeReport (runDir: string): Promise<string> {
  const html = renderHtml(analyze(await loadRun(runDir)))
  const out = join(runDir, RUN_FILES.report)
  await writeFile(out, html, 'utf8')
  return out
}

/** Writes an HTML comparison of run B (`dirB`) against baseline A (`dirA`) to `outFile`. */
export async function writeCompare (dirA: string, dirB: string, outFile: string): Promise<string> {
  const [a, b] = await Promise.all([loadRun(dirA), loadRun(dirB)])
  const html = renderCompareHtml(compareRuns(analyze(a), analyze(b)))
  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, html, 'utf8')
  return outFile
}
