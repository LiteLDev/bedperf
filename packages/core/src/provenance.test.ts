import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { canonicalJson, harnessInfo, machineInfo, parseCpuinfoCores, physicalCores, Scrubber, sha256Json, type ExecFn } from './provenance.ts'

const WINDOWS = process.platform === 'win32'

test('canonicalJson sorts keys recursively, no whitespace, rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  assert.equal(canonicalJson({ a: undefined, b: [undefined] }), '{"b":[null]}')
  assert.equal(canonicalJson('é"'), '"é\\""')
  assert.throws(() => canonicalJson({ x: Number.NaN }), /non-finite/)
  assert.throws(() => canonicalJson([Infinity]), /non-finite/)
  assert.equal(sha256Json({ b: 1, a: 2 }), createHash('sha256').update('{"a":2,"b":1}').digest('hex'))
  assert.equal(sha256Json({ b: 1, a: 2 }), sha256Json({ a: 2, b: 1 }))
})

test('parseCpuinfoCores counts unique (physical id, core id)', () => {
  const block = (p: number, c: number): string => `processor\t: 0\nphysical id\t: ${p}\ncore id\t\t: ${c}\n`
  const text = [block(0, 0), block(0, 0), block(0, 1), block(0, 1), block(1, 0), block(1, 1)].join('\n')
  assert.equal(parseCpuinfoCores(text), 4)
  assert.equal(parseCpuinfoCores('processor : 0\nmodel name : x\n'), undefined)
})

test('physicalCores: Windows sums NumberOfCores via PowerShell, failures give undefined', async () => {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd, args) => { calls.push([cmd, ...args]); return '16\r\n' }
  assert.equal(await physicalCores({ platform: 'win32', exec }), 16)
  assert.match(calls[0]!.join(' '), /Win32_Processor.*NumberOfCores/)
  assert.equal(await physicalCores({ platform: 'win32', exec: async () => { throw new Error('no powershell') } }), undefined)
  assert.equal(await physicalCores({ platform: 'linux', readFile: () => { throw new Error('ENOENT') } }), undefined)
})

test('machineInfo fingerprint: stable, hardware-only, 16 hex digits', async () => {
  const base = {
    platform: 'linux' as const,
    cpus: () => Array.from({ length: 8 }, () => ({ model: '  Some  CPU 9000 ' })),
    totalmem: () => 31.6 * 2 ** 30,
    osType: () => 'Linux',
    osRelease: () => '6.1.0',
    readFile: () => 'physical id : 0\ncore id : 0\n\nphysical id : 0\ncore id : 1\n'
  }
  const m = await machineInfo(base)
  assert.match(m.fingerprint, /^[0-9a-f]{16}$/)
  assert.deepEqual({ ...m, fingerprint: '' }, { fingerprint: '', os: 'Linux 6.1.0', cpuModel: 'Some CPU 9000', logical: 8, physical: 2, ramGiB: 31.6 })
  assert.equal(m.fingerprint, sha256Json({ osFamily: 'linux', cpuModel: 'Some CPU 9000', logical: 8, physical: 2, ramGiB: 32 }).slice(0, 16))
  // OS updates do not change it; RAM within the same whole GiB does not either; hardware does.
  assert.equal((await machineInfo({ ...base, osRelease: () => '6.9.0', totalmem: () => 32.2 * 2 ** 30 })).fingerprint, m.fingerprint)
  assert.notEqual((await machineInfo({ ...base, cpus: () => Array.from({ length: 16 }, () => ({ model: 'Some CPU 9000' })) })).fingerprint, m.fingerprint)
})

test('harnessInfo: commit, dirty, node; tolerates missing git', async () => {
  const sha = 'a'.repeat(40)
  const seen: string[] = []
  const exec: ExecFn = async (_cmd, args) => {
    seen.push(args.join(' '))
    return args.includes('rev-parse') ? `${sha}\n` : ' M packages/core/src/run.ts\n'
  }
  assert.deepEqual(await harnessInfo({ version: '1.2.3', exec, repo: '/r', nodeVersion: 'v24.0.0' }), { version: '1.2.3', git: sha, dirty: true, node: 'v24.0.0' })
  assert.ok(seen.some(s => s.includes('status --porcelain --untracked-files=no -- packages scripts')))
  const clean: ExecFn = async (_c, args) => (args.includes('rev-parse') ? sha : '')
  assert.equal((await harnessInfo({ version: '1', exec: clean })).dirty, false)
  assert.deepEqual(await harnessInfo({ version: '1', exec: async () => { throw new Error('ENOENT') }, nodeVersion: 'v24' }), { version: '1', node: 'v24' })
})

function scrubber (roots: Record<string, string> = {}): Scrubber {
  return new Scrubber(roots, { user: 'benchuser', host: 'bench-host-01', defaultRoots: false })
}

test('Scrubber: roots, both separators, most specific wins, root boundaries', () => {
  if (WINDOWS) {
    const s = scrubber({ '<run>': 'C:\\bb\\w\\abc123' })
    assert.equal(s.text('C:\\bb\\w\\abc123\\crash_reports\\crash-1.txt'), '<run>/crash_reports/crash-1.txt')
    assert.equal(s.text('c:/bb/w/abc123/worlds/bench'), '<run>/worlds/bench')
    assert.equal(s.text('saved to: C:\\bb\\w\\abc123\\x.txt now'), 'saved to: <run>/x.txt now')
  } else {
    const s = scrubber({ '<run>': '/srv/bb/w/abc123' })
    assert.equal(s.text('/srv/bb/w/abc123/crash_reports/crash-1.txt'), '<run>/crash_reports/crash-1.txt')
    assert.equal(s.text('/srv/bb/w/abc1234/x'), '/srv/bb/w/abc1234/x')
  }
  const tmp = os.tmpdir()
  const cache = path.join(tmp, 'cache')
  const work = path.join(cache, 'w', 'abc')
  const s = scrubber({ '<cache>': cache, '<run>': work })
  assert.equal(s.text(path.join(work, 'server.properties')), '<run>/server.properties')
  assert.equal(s.text(path.join(cache, 'dl', 'x.zip')), '<cache>/dl/x.zip')
  assert.equal(s.text(work), '<run>')
  assert.ok(!s.text(path.join(cache, 'w', 'abc1', 'x')).startsWith('<run>'))
})

test('Scrubber: default roots hide the home directory', () => {
  const p = path.join(os.homedir(), 'projects', 'thing.txt')
  const out = new Scrubber().text(p)
  assert.ok(out.endsWith('/projects/thing.txt'), out)
  assert.ok(out.startsWith('<'), out)
})

test('Scrubber: leftover absolute paths become <abs>/<basename>', () => {
  const s = scrubber()
  assert.equal(s.text('D:\\Somewhere\\Else\\bedrock_server.exe'), '<abs>/bedrock_server.exe')
  assert.equal(s.text('see \\\\nas\\share\\file.log'), 'see <abs>/file.log')
  assert.equal(s.text('/home/someone/bench/run.log'), '<abs>/run.log')
  assert.equal(s.text('/mnt/data/xyz'), '<abs>/xyz')
  assert.equal(s.text('/tmp'), '<abs>/tmp')
  assert.equal(s.text('/tmpfoo/x'), '/tmpfoo/x')
  assert.equal(s.text('/lib/x86_64-linux-gnu/libc.so.6'), '/lib/x86_64-linux-gnu/libc.so.6')
  const url = 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.52.3.zip'
  assert.equal(s.text(url), url)
  assert.equal(s.text('files.example.org/packages/home/x'), 'files.example.org/packages/home/x')
  assert.equal(s.text('<run>/tmp/file'), '<run>/tmp/file')
  // A value that is one whole path keeps its spaces inside the path.
  assert.equal(s.text('D:\\Client Projects\\Acme Secret\\world'), '<abs>/world')
  assert.equal(s.text('/home/John Smith/bench/x.log'), '<abs>/x.log')
  assert.deepEqual(s.leaks(s.scrub(['D:\\Client Projects\\Acme Secret\\world'])), [])
  assert.equal(s.text('/say hello world'), '/say hello world')
  const r = scrubber({ '<run>': WINDOWS ? 'C:\\Users\\John Smith\\runs\\r1' : '/srv/John Smith/runs/r1' })
  assert.equal(r.text(WINDOWS ? 'C:\\Users\\John Smith\\runs\\r1\\bds log.txt' : '/srv/John Smith/runs/r1/bds log.txt'), '<run>/bds log.txt')
})

test('Scrubber: user and host as case-insensitive whole words, short/common names left alone', () => {
  const s = scrubber()
  assert.equal(s.text('started by benchuser on bench-host-01'), 'started by <user> on <host>')
  assert.equal(s.text('BENCHUSER'), '<user>')
  assert.equal(s.text('benchusers bench-host-012'), 'benchusers bench-host-012')
  const t = new Scrubber({}, { user: 'root', host: 'ab', defaultRoots: false })
  assert.equal(t.text('root cause in ab'), 'root cause in ab')
  assert.equal(new Scrubber({}, { user: null, host: 'localhost', defaultRoots: false }).text('localhost'), 'localhost')
})

test('Scrubber: nested data and keys; leaks finds what is left', () => {
  const runDir = path.join(os.tmpdir(), 'runs', 'm', 'r1')
  const s = scrubber({ '<run>': runDir })
  const data = {
    files: { [path.join(runDir, 'server.log')]: { bytes: 10 } },
    argv: [path.join(runDir, 'bots.exe'), '-addr', '127.0.0.1:19672'],
    mixed: [runDir, 1, null, true, 2.5],
    note: 'made by benchuser'
  }
  const out = s.scrub(data)
  assert.deepEqual(out.files, { '<run>/server.log': { bytes: 10 } })
  assert.deepEqual(out.argv, ['<run>/bots.exe', '-addr', '127.0.0.1:19672'])
  assert.deepEqual(out.mixed, ['<run>', 1, null, true, 2.5])
  assert.equal(out.note, 'made by <user>')
  assert.deepEqual(s.leaks(out), [])
  const leaky = { a: 'C:\\Users\\x\\file', b: ['/home/x/y'], c: 'bench-host-01', ok: 'fine', '/root/key': 1 }
  assert.deepEqual(s.leaks(leaky).sort(), ['/home/x/y', '/root/key', 'C:\\Users\\x\\file', 'bench-host-01'].sort())
  assert.deepEqual(s.leaks(s.scrub(leaky)), [])
})
