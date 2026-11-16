import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHelperLine, windowsHelperScript } from './windows.ts'

test('parseHelperLine: sample', () => {
  const line = 'BPSM {"seq":3,"t":1700000000123,"cpu":15000,"ws":262144000,"pb":300000000,"h":812,"th":[[100,9000],[104,12]],"net":[["{A-1}",5000,7000],["{B-2}",1,2]],"self":420}'
  assert.deepEqual(parseHelperLine(line), {
    kind: 'reading',
    seq: 3,
    selfCpuMs: 420,
    raw: {
      t: 1700000000123,
      procCpuMs: 15000,
      rssBytes: 262144000,
      privateBytes: 300000000,
      handles: 812,
      threadCount: 2,
      threads: [{ tid: 100, cpuMs: 9000 }, { tid: 104, cpuMs: 12 }],
      net: [{ name: '{A-1}', rxBytes: 5000, txBytes: 7000 }, { name: '{B-2}', rxBytes: 1, txBytes: 2 }]
    }
  })
})

test('parseHelperLine: thread names (third element), empty names dropped', () => {
  const m = parseHelperLine('BPSM {"t":1,"cpu":2,"ws":3,"th":[[7,10,"MC_SERVER"],[8,0,""],[9,1],[10,2,"caf\\u00e9 \\"x\\""]]}')
  assert.equal(m?.kind, 'reading')
  if (m?.kind !== 'reading') return
  assert.deepEqual(m.raw.threads, [
    { tid: 7, name: 'MC_SERVER', cpuMs: 10 }, { tid: 8, cpuMs: 0 }, { tid: 9, cpuMs: 1 }, { tid: 10, name: 'café "x"', cpuMs: 2 }
  ])
})

test('parseHelperLine: without net/threads', () => {
  const m = parseHelperLine('BPSM {"t":1,"cpu":2,"ws":3}')
  assert.deepEqual(m, { kind: 'reading', raw: { t: 1, procCpuMs: 2, rssBytes: 3 } })
})

test('parseHelperLine: exited, error, noise, malformed', () => {
  assert.deepEqual(parseHelperLine('BPSM {"exited":true}'), { kind: 'exited' })
  assert.deepEqual(parseHelperLine('BPSM {"seq":9,"exited":true}'), { kind: 'exited', seq: 9 })
  assert.deepEqual(parseHelperLine('BPSM {"error":"Access is denied"}'), { kind: 'error', message: 'Access is denied' })
  assert.equal(parseHelperLine(''), null)
  assert.equal(parseHelperLine('PS C:\\> something'), null)
  assert.equal(parseHelperLine('BPSM {not json')!.kind, 'error')
  assert.equal(parseHelperLine('BPSM {"t":1}')!.kind, 'error')
  assert.equal(parseHelperLine('BPSM 5')!.kind, 'error')
})

test('helper script is one line and embeds the pid', () => {
  const s = windowsHelperScript(1234, true)
  assert.ok(!s.includes('\n'))
  assert.ok(s.includes('GetProcessById(1234)'))
  assert.ok(s.includes('GetAllNetworkInterfaces'))
  assert.ok(!windowsHelperScript(1234, false).includes('GetAllNetworkInterfaces'))
  assert.ok(s.includes('GetThreadDescription') && s.includes('-ge 10000'))
  assert.ok(windowsHelperScript(1234, true, { nameRefreshMs: 2500 }).includes('-ge 2500'))
  assert.ok(!windowsHelperScript(1234, true, { threadNames: false }).includes('Add-Type'))
  assert.throws(() => windowsHelperScript(0, true))
  assert.throws(() => windowsHelperScript(1.5, true))
})
