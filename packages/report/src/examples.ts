// Regenerates examples/report.html and examples/compare.html from synthetic fixture runs:
//   node packages/report/src/examples.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import { compareRuns, renderCompareHtml } from './compare.ts'
import { generateRun } from './fixtures.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples')
const tmp = await mkdtemp(join(tmpdir(), 'bedperf-report-examples-'))
try {
  // Both runs carry the newer measurements (tick counter, tick CPU, interference, view load,
  // placement and provenance). Run A has one crashed repeat and one step invalidated by a
  // foreign-load spike, so the report shows statuses, k/n ok, invalid reasons and threats.
  const a = await generateRun(join(tmp, 'a'), {
    seed: 1,
    repeats: 5,
    extended: true,
    interferenceStep: { repeat: 2, index: 1 },
    repeatOutcomes: { 4: { aborted: 'server exited unexpectedly (code 3221225477) at 42 players' } }
  })
  const b = await generateRun(join(tmp, 'b'), { seed: 2, name: 'walk-tuned', runId: '20260102-000000-fixture', repeats: 5, capacity: 50, memPerPlayerBytes: 7 * 1024 * 1024, extended: true, tickCpuScale: 0.8 })
  const an = analyze(await loadRun(a.dir))
  const bn = analyze(await loadRun(b.dir))
  await writeFile(join(out, 'report.html'), renderHtml(an))
  await writeFile(join(out, 'compare.html'), renderCompareHtml(compareRuns(an, bn)))
  console.log(`wrote ${join(out, 'report.html')} and ${join(out, 'compare.html')}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
