// Regenerates examples/report.html, compare.html, remote.html and matrix.html from synthetic fixture runs:
//   node packages/report/src/examples.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import { compareRuns, renderCompareHtml } from './compare.ts'
import { generateRun, remoteTopologyFixture } from './fixtures.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'
import { compareMatrix, renderMatrixHtml } from './matrix.ts'

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
  // A LeviLamina run with bots on two remote agents (one saturates, one drops its connection).
  const remote = await generateRun(join(tmp, 'remote'), { seed: 3, runId: '20260103-000000-fixture', extended: true, server: 'levilamina', topology: remoteTopologyFixture() })
  await writeFile(join(out, 'remote.html'), renderHtml(analyze(await loadRun(remote.dir))))
  // Implementation comparison of four server flavors on one machine.
  const flavors = [['bds', [38, 40, 42]], ['levilamina', [37, 39, 41]], ['levilamina-levioptimize', [50, 52, 55]], ['endstone', [35, 37, 40]]] as const
  const runs = await Promise.all(flavors.map(async ([server, capacities], i) => {
    const fx = await generateRun(join(tmp, server), { seed: 10 + i, runId: `20260104-00000${i}-fixture`, extended: true, server, capacities: [...capacities] })
    return analyze(await loadRun(fx.dir))
  }))
  await writeFile(join(out, 'matrix.html'), renderMatrixHtml(compareMatrix(runs)))
  console.log(`wrote report.html, compare.html, remote.html and matrix.html in ${out}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
