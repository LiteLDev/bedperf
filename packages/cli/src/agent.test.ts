import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { connectAgents, type AgentPool } from '@bedperf/agent'
import { EngineAgents, silentLogger } from '@bedperf/orchestrator'
import { parseArgs, UsageError } from './args.ts'
import { agentOptionsFromArgs, startAgentCommand } from './agent.ts'
import { agentsFromArgs, configFromArgs } from './main.ts'

const TOKEN = { BEDPERF_AGENT_TOKEN: 'secret' }

test('agentsFromArgs: --agents, bot target host rules, token required', async () => {
  assert.equal(await agentsFromArgs(parseArgs(['run']), TOKEN), undefined)
  assert.deepEqual(await agentsFromArgs(parseArgs(['run', '--agents', '10.0.0.5:19260,10.0.0.6:19260', '--bot-target-host', '10.0.0.2']), TOKEN), {
    specs: [{ address: '10.0.0.5:19260' }, { address: '10.0.0.6:19260' }],
    botTargetHost: '10.0.0.2'
  })
  // all agents on this machine: the bots dial loopback
  assert.equal((await agentsFromArgs(parseArgs(['run', '--agents', '127.0.0.1:19411']), TOKEN))?.botTargetHost, '127.0.0.1')
  await assert.rejects(agentsFromArgs(parseArgs(['run', '--agents', '10.0.0.5:19260']), TOKEN), (e: unknown) => e instanceof UsageError && /--bot-target-host is required/.test(e.message))
  await assert.rejects(agentsFromArgs(parseArgs(['run', '--agents', '10.0.0.5:19260', '--bot-target-host', '127.0.0.1']), TOKEN), (e: unknown) => e instanceof UsageError && /loopback/.test(e.message))
  await assert.rejects(agentsFromArgs(parseArgs(['run', '--agents', '10.0.0.5:19260', '--bot-target-host', '10.0.0.2']), {}), (e: unknown) => e instanceof UsageError && /BEDPERF_AGENT_TOKEN/.test(e.message))
  await assert.rejects(agentsFromArgs(parseArgs(['run', '--bot-target-host', '10.0.0.2']), TOKEN), UsageError)
  await assert.rejects(agentsFromArgs(parseArgs(['run', '--agents', 'a:1,a:1']), TOKEN), UsageError)
})

test('machine profile agents: used for the run, never part of the config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-agents-'))
  try {
    const file = path.join(dir, 'profile.json')
    await writeFile(file, JSON.stringify({ label: 'lab', agents: [{ address: '10.0.0.5:19260', weight: 2 }, '10.0.0.6:19260'], gates: { idleSec: 5 } }))
    const args = parseArgs(['run', '--machine-profile', file, '--bot-target-host', '10.0.0.2'])
    const c = await configFromArgs(args)
    assert.equal(c.gates?.idleSec, 5)
    assert.ok(!JSON.stringify(c).includes('10.0.0.5'))
    const a = await agentsFromArgs(args, TOKEN)
    assert.deepEqual(a?.specs, [{ address: '10.0.0.5:19260', weight: 2 }, { address: '10.0.0.6:19260' }])
    // --agents overrides the profile
    const b = await agentsFromArgs(parseArgs(['run', '--machine-profile', file, '--agents', '127.0.0.1:1']), TOKEN)
    assert.deepEqual(b, { specs: [{ address: '127.0.0.1:1' }], botTargetHost: '127.0.0.1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent flags', () => {
  const o = agentOptionsFromArgs(parseArgs(['agent', '--listen', '127.0.0.1:19411', '--name', 'lg1', '--max-workers', '4', '--no-lock', '--saturation-foreign', '0.01']), TOKEN)
  assert.deepEqual(o.agent.listen, { host: '127.0.0.1', port: 19411 })
  assert.equal(o.agent.token, 'secret')
  assert.equal(o.agent.name, 'lg1')
  assert.equal(o.agent.maxWorkers, 4)
  assert.deepEqual(o.agent.saturation, { foreignCores: 0.01 })
  assert.equal(o.lock, false)
  assert.equal(o.placement, 'off')
  assert.equal(agentOptionsFromArgs(parseArgs(['agent']), TOKEN).agent.listen.port, 19260)
  assert.throws(() => agentOptionsFromArgs(parseArgs(['agent', '--placement', 'on']), TOKEN), UsageError)
  assert.throws(() => agentOptionsFromArgs(parseArgs(['agent', '--max-workers', '0']), TOKEN), UsageError)
  assert.throws(() => agentOptionsFromArgs(parseArgs(['agent']), {}), /BEDPERF_AGENT_TOKEN/)
  assert.equal(agentOptionsFromArgs(parseArgs(['agent', '--insecure', '--listen', '127.0.0.1:0']), {}).agent.insecure, true)
})

test('bedperf agent ↔ orchestrator: connect, topology with link stats, session lock, close', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-agentlock-'))
  const lockPath = path.join(dir, 'machine.lock')
  const o = agentOptionsFromArgs(parseArgs(['agent', '--listen', '127.0.0.1:0', '--name', 'lg1', '--lock-path', lockPath]), TOKEN)
  const server = await startAgentCommand(o, silentLogger)
  try {
    const address = `127.0.0.1:${server.address.port}`
    const agents = new EngineAgents<AgentPool>({
      specs: [{ address, weight: 2 }],
      botTargetHost: '127.0.0.1',
      linkPings: 3,
      connect: events => connectAgents([{ address, weight: 2 }], { token: 'secret', onTelemetry: events.telemetry, onLink: events.link, log: () => {} })
    })
    await agents.ensure()
    const t = agents.topology()
    assert.equal(t.mode, 'remote')
    assert.equal(t.agents[0]!.name, 'lg1')
    assert.equal(t.agents[0]!.weight, 2)
    assert.equal(t.agents[0]!.link?.rttMs.n, 3)
    assert.ok(!JSON.stringify(t).includes(address))
    assert.deepEqual(agents.takePending().map(e => e.event), ['connected', 'stats'])
    // the agent holds the machine lock while the session is active
    const { existsSync } = await import('node:fs')
    assert.ok(existsSync(lockPath))
    await agents.close()
    for (let i = 0; i < 50 && existsSync(lockPath); i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(!existsSync(lockPath), 'lock released when the session ends')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
