import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { makeFakeBdsZip } from './testutil.ts'
import { extractZip, listZipEntries } from './zip.ts'

test('extract a small fflate-made zip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bedperf-zip-'))
  try {
    const zip = makeFakeBdsZip()
    const names = listZipEntries(zip).map(e => e.name).sort()
    assert.ok(names.includes('data/big.bin'))
    const r = await extractZip(zip, dir)
    assert.equal(r.files, 5)
    assert.equal(readFileSync(join(dir, 'stored.txt'), 'utf8'), 'raw')
    assert.equal(readFileSync(join(dir, 'behavior_packs', 'vanilla', 'manifest.json'), 'utf8'), '{}')
    const big = readFileSync(join(dir, 'data', 'big.bin'))
    assert.equal(big.length, 200_000)
    assert.equal(big[13], 13 % 7)
    assert.ok(existsSync(join(dir, 'empty')))
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'bedrock_server')).mode & 0o777, 0o755)
      assert.equal(statSync(join(dir, 'server.properties')).mode & 0o777, 0o644)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bedrock_server gets the exec bit even without Unix attrs', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bedperf-zip-'))
  try {
    await extractZip(zipSync({ bedrock_server: strToU8('x') }), dir)
    assert.ok((statSync(join(dir, 'bedrock_server')).mode & 0o111) !== 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects corrupt and path-traversal archives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bedperf-zip-'))
  try {
    await assert.rejects(extractZip(zipSync({ '../evil.txt': strToU8('x') }), join(dir, 'out')), /escapes/)
    assert.ok(!existsSync(join(dir, 'evil.txt')))
    const zip = zipSync({ 'a.txt': [strToU8('hello hello hello'), { level: 0 }] })
    const i = Buffer.from(zip).indexOf('hello')
    zip[i] = 'j'.charCodeAt(0)
    await assert.rejects(extractZip(zip, join(dir, 'out2')), /CRC mismatch/)
    await assert.rejects(extractZip(strToU8('not a zip at all, not even close'), join(dir, 'out3')), /not a zip/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
