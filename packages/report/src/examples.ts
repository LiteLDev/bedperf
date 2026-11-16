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
  const meta = {
    configSha256: '3f9a1c0e5b7d2468ace013579bdf2468ace013579bdf2468ace013579bdf2468',
    machine: { fingerprint: 'win32-x64-AMD Ryzen 9 7950X-32t-64GiB' },
    analysisVersion: 1,
    bdsBuildSha256: '8e1d4c2b9a7f6e5d4c3b2a19f8e7d6c5b4a39281706f5e4d3c2b1a0918273645',
    placement: { profileSha256: 'c0ffee00d15ea5e0c0ffee00d15ea5e0c0ffee00d15ea5e0c0ffee00d15ea5e0' }
  }
  // A run with one crashed repeat, so the report shows statuses and k/n ok.
  const a = await generateRun(join(tmp, 'a'), {
    seed: 1,
    repeats: 5,
    metaExtra: meta,
    repeatOutcomes: { 4: { aborted: 'server exited unexpectedly (code 3221225477) at 42 players' } }
  })
  const b = await generateRun(join(tmp, 'b'), { seed: 2, name: 'walk-tuned', runId: '20260102-000000-fixture', repeats: 5, capacity: 50, memPerPlayerBytes: 7 * 1024 * 1024, metaExtra: meta })
  const an = analyze(await loadRun(a.dir))
  const bn = analyze(await loadRun(b.dir))
  await writeFile(join(out, 'report.html'), renderHtml(an))
  await writeFile(join(out, 'compare.html'), renderCompareHtml(compareRuns(an, bn)))
  console.log(`wrote ${join(out, 'report.html')} and ${join(out, 'compare.html')}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
