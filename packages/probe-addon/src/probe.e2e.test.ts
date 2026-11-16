// Real-BDS check of the probe pack. Runs only when BEDPERF_E2E=1 (needs the BDS cache; see repo README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProbeLine, type ProbeRecord, type ProbeSample } from '@bedperf/core'
// testkit is a test-only helper and not a declared dependency of this package; import it by path.
import { createTestBot, startTestBds } from '../../testkit/src/index.ts'
import { packDir, summarizeProbe } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const PORT = 19230

interface BedrockInternals {
  _bedrock: { commands: { request (cmd: string, opts?: { timeout?: number }): Promise<unknown> } }
}

test('probe pack reports samples, marks and pongs on a real BDS', { skip: !e2e, timeout: 240_000 }, async () => {
  const bds = await startTestBds({
    port: PORT,
    behaviorPacks: [packDir()],
    properties: { 'allow-cheats': true, 'default-player-permission-level': 'operator' }
  })
  const records: ProbeRecord[] = []
  const collect = (l: string): void => { const r = parseProbeLine(l); if (r) records.push(r) }
  for (const l of bds.lines) collect(l)
  const off = bds.onLine(collect)
  try {
    const startLine = await bds.waitForLine(/bedperf-probe .*"event":"start"/, 30_000, true)
    console.log('probe:', startLine)

    // >= 10 samples on an idle server
    const deadline = Date.now() + 30_000
    while (records.filter(r => r.type === 'sample').length < 10 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
    }
    const samples = records.filter((r): r is ProbeSample => r.type === 'sample')
    assert.ok(samples.length >= 10, `only ${samples.length} samples`)
    const sum = summarizeProbe(samples.slice(1)) // first window may include world-load jitter
    console.log('idle summary:', JSON.stringify(sum))
    assert.ok(sum.windowTps.mean >= 19 && sum.windowTps.mean <= 21, `mean tps ${sum.windowTps.mean}`)
    const withEntities = samples.filter(s => s.entities)
    assert.ok(withEntities.length >= 1, 'no entities sample')
    console.log('entities:', JSON.stringify(withEntities.at(-1)!.entities))

    // mark via console
    bds.send('scriptevent bedperf:mark hello')
    const markLine = await bds.waitForLine(/BEDPERF\|.*"type":"mark"/, 10_000, true)
    assert.deepEqual((parseProbeLine(markLine) as { label: string }).label, 'hello')

    // ping from a bot: stdout pong + message back to the player
    const bot = await createTestBot({ port: PORT, username: 'u3bot' })
    try {
      await bds.waitForLine(/Player connected: u3bot/, 10_000, true)
      const gotMessage = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no pong message to bot')), 10_000)
        const onMsg = (m: string): void => {
          if (m.includes('BEDPERF|pong abc')) { clearTimeout(timer); bot.off('messagestr', onMsg); resolve(performance.now()) }
        }
        bot.on('messagestr', onMsg)
      })
      const pongLine = bds.waitForLine(/BEDPERF\|.*"type":"pong".*"id":"abc"/, 10_000)
      const t0 = performance.now()
      await (bot as unknown as BedrockInternals)._bedrock.commands.request('/scriptevent bedperf:ping abc', { timeout: 10_000 })
      const tCmd = performance.now()
      const tMsg = await gotMessage
      await pongLine
      console.log(`RTT: command_output ${(tCmd - t0).toFixed(1)} ms, pong message ${(tMsg - t0).toFixed(1)} ms`)

      // with a player online the sample should count it
      await bds.waitForLine(/BEDPERF\|.*"type":"sample".*"players":1/, 5_000)
    } finally {
      bot.end()
    }

    // self-reported overhead
    bds.send('scriptevent bedperf:info')
    const info = await bds.waitForLine(/bedperf-probe .*"event":"info"/, 10_000)
    console.log('probe overhead:', info.slice(info.indexOf('bedperf-probe')))
  } finally {
    off()
    await bds.stop()
  }
})
