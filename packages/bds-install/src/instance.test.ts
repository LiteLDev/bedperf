import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, destroyInstance, INSTANCE_MARKER } from './instance.ts'
import { serverExeName } from './platform.ts'
import { parseServerProperties } from './properties.ts'
import { saveWorldSnapshot } from './snapshot.ts'

const V = '9.9.9.9'

function fakeCache (root: string): string {
  const dir = join(root, V)
  mkdirSync(join(dir, 'behavior_packs', 'vanilla'), { recursive: true })
  writeFileSync(join(dir, serverExeName()), 'exe')
  writeFileSync(join(dir, 'server.properties'), 'server-name=Dedicated Server\nonline-mode=true\nview-distance=32\n')
  writeFileSync(join(dir, 'behavior_packs', 'vanilla', 'manifest.json'), '{}')
  return dir
}

function fakePack (root: string, uuid: string, version: number[] | string): string {
  const dir = join(root, `pack-${uuid}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format_version: 2, header: { uuid, version, name: 'p' } }))
  return dir
}

test('createInstance copies pristine, merges properties, installs packs; destroy cleans up', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bedperf-inst-'))
  try {
    const pristine = fakeCache(join(tmp, 'cache'))
    const packA = fakePack(tmp, 'aaaaaaaa-0000-0000-0000-000000000001', [1, 2, 3])
    const packB = fakePack(tmp, 'bbbbbbbb-0000-0000-0000-000000000001', '0.1.0')
    const inst = await createInstance({
      version: V,
      cacheRoot: join(tmp, 'cache'),
      dir: join(tmp, 'inst'),
      port: 19210,
      levelName: 'lvl',
      presets: ['bench-default'],
      properties: { 'view-distance': 12 },
      behaviorPacks: [packA, packB, packA]
    })
    assert.deepEqual({ ...inst, dir: undefined }, { dir: undefined, version: V, platform: inst.platform, port: 19210, portV6: 19211, levelName: 'lvl' })
    const p = parseServerProperties(readFileSync(join(inst.dir, 'server.properties'), 'utf8'))
    assert.equal(p['view-distance'], '12')
    assert.equal(p['tick-distance'], '4')
    assert.equal(p['online-mode'], 'false')
    assert.equal(p['server-portv6'], '19211')
    assert.equal(p['level-name'], 'lvl')
    // the pristine file is untouched
    assert.match(readFileSync(join(pristine, 'server.properties'), 'utf8'), /online-mode=true/)
    const list = JSON.parse(readFileSync(join(inst.dir, 'worlds', 'lvl', 'world_behavior_packs.json'), 'utf8')) as unknown
    assert.deepEqual(list, [
      { pack_id: 'bbbbbbbb-0000-0000-0000-000000000001', version: [0, 1, 0] },
      { pack_id: 'aaaaaaaa-0000-0000-0000-000000000001', version: [1, 2, 3] }
    ])
    assert.ok(existsSync(join(inst.dir, 'behavior_packs', 'bedperf_aaaaaaaa', 'manifest.json')))
    assert.ok(existsSync(join(inst.dir, 'behavior_packs', 'vanilla', 'manifest.json')))

    await destroyInstance(inst)
    assert.ok(!existsSync(inst.dir))
    await destroyInstance(inst) // idempotent
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createInstance restores a world snapshot; guards against misuse', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bedperf-inst-'))
  try {
    fakeCache(join(tmp, 'cache'))
    const store = join(tmp, 'store')
    const world = join(tmp, 'src', 'worlds', 'w')
    mkdirSync(join(world, 'db'), { recursive: true })
    writeFileSync(join(world, 'db', 'CURRENT'), 'x')
    await saveWorldSnapshot({ dir: join(tmp, 'src'), levelName: 'w', version: V }, 's1', store)

    const inst = await createInstance({ version: V, cacheRoot: join(tmp, 'cache'), port: 19210, worldSnapshot: { id: 's1', store } })
    assert.equal(readFileSync(join(inst.dir, 'worlds', 'bedperf', 'db', 'CURRENT'), 'utf8'), 'x')
    assert.ok(existsSync(join(inst.dir, INSTANCE_MARKER)))
    await destroyInstance(inst)

    await assert.rejects(createInstance({ version: '1.0.0.0', cacheRoot: join(tmp, 'cache'), port: 1 }), /ensureBds/)
    mkdirSync(join(tmp, 'busy'))
    writeFileSync(join(tmp, 'busy', 'keep.txt'), 'keep')
    await assert.rejects(createInstance({ version: V, cacheRoot: join(tmp, 'cache'), port: 1, dir: join(tmp, 'busy') }), /not empty/)
    assert.ok(existsSync(join(tmp, 'busy', 'keep.txt')))
    await assert.rejects(destroyInstance({ dir: join(tmp, 'busy') }), /refusing/)
    assert.ok(existsSync(join(tmp, 'busy', 'keep.txt')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
