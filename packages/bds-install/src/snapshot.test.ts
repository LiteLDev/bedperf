import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashTree, listTree, readSnapshotManifest, restoreWorldSnapshot, saveWorldSnapshot } from './snapshot.ts'

function writeTree (root: string, files: Record<string, string>, order: string[] = Object.keys(files)): void {
  for (const p of order) {
    const f = join(root, ...p.split('/'))
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, files[p]!)
  }
}

const WORLD = {
  'db/CURRENT': 'MANIFEST-000001\n',
  'db/000003.ldb': 'chunks',
  'level.dat': 'LEVEL',
  'levelname.txt': 'bedperf',
  'world_behavior_packs.json': '[]'
}

test('tree hash is stable across creation order and location, and content-sensitive', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bedperf-hash-'))
  try {
    writeTree(join(tmp, 'a'), WORLD)
    writeTree(join(tmp, 'b'), WORLD, Object.keys(WORLD).reverse())
    const h = hashTree(join(tmp, 'a'))
    assert.match(h, /^[0-9a-f]{64}$/)
    assert.equal(hashTree(join(tmp, 'b')), h)
    assert.deepEqual(listTree(join(tmp, 'a')).map(f => f.path), ['db/000003.ldb', 'db/CURRENT', 'level.dat', 'levelname.txt', 'world_behavior_packs.json'])
    writeFileSync(join(tmp, 'b', 'level.dat'), 'LEVEL2')
    assert.notEqual(hashTree(join(tmp, 'b')), h)
    // Moving bytes between files changes the hash too.
    writeTree(join(tmp, 'c'), { x: 'ab', y: 'c' })
    writeTree(join(tmp, 'd'), { x: 'a', y: 'bc' })
    assert.notEqual(hashTree(join(tmp, 'c')), hashTree(join(tmp, 'd')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('save and restore a world snapshot', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bedperf-snap-'))
  try {
    const store = join(tmp, 'store')
    const src = { dir: join(tmp, 'inst1'), levelName: 'lvl', version: '1.2.3.4' }
    writeTree(join(src.dir, 'worlds', 'lvl'), WORLD)
    const m = await saveWorldSnapshot(src, 'snap-1', store)
    assert.equal(m.hash, hashTree(join(src.dir, 'worlds', 'lvl')))
    assert.equal(m.files.length, 5)
    assert.equal(readSnapshotManifest('snap-1', store).hash, m.hash)
    await assert.rejects(saveWorldSnapshot(src, 'snap-1', store), /already exists/)
    await assert.rejects(saveWorldSnapshot(src, '../x', store), /invalid snapshot id/)

    const dst = { dir: join(tmp, 'inst2'), levelName: 'other' }
    writeTree(join(dst.dir, 'worlds', 'other'), { 'stale.txt': 'old' })
    await restoreWorldSnapshot('snap-1', dst, store)
    assert.equal(hashTree(join(dst.dir, 'worlds', 'other')), m.hash)

    writeFileSync(join(store, 'snap-1', 'world', 'level.dat'), 'tampered')
    await assert.rejects(restoreWorldSnapshot('snap-1', dst, store), /corrupt/)
    assert.equal(readFileSync(join(dst.dir, 'worlds', 'other', 'level.dat'), 'utf8'), 'LEVEL')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
