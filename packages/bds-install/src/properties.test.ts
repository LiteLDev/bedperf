import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED_BOT_PROPERTIES } from '@bedperf/core'
import { instancePropertyLayers, mergeServerProperties, parseServerProperties, presetProperties, PRESETS } from './properties.ts'

const PRISTINE = [
  'server-name=Dedicated Server',
  '# Used as the server name',
  'online-mode=true',
  'view-distance=32',
  'server-port=19132',
  '# trailing comment',
  ''
].join('\r\n')

test('merge rewrites in place, keeps comments/EOL and appends new keys', () => {
  const out = mergeServerProperties(PRISTINE, { 'online-mode': false, foo: 1 }, { 'view-distance': 10, foo: 2, bar: 'x' })
  assert.equal(out, [
    'server-name=Dedicated Server',
    '# Used as the server name',
    'online-mode=false',
    'view-distance=10',
    'server-port=19132',
    '# trailing comment',
    'foo=2',
    'bar=x',
    ''
  ].join('\r\n'))
})

test('layer order: pristine < required < presets < overrides < identity', () => {
  const layers = instancePropertyLayers({
    presets: ['bench-default', { 'view-distance': 6 }],
    properties: { 'tick-distance': 6, 'server-port': 1 },
    port: 19210,
    portV6: 19211,
    levelName: 'lvl'
  })
  const p = parseServerProperties(mergeServerProperties(PRISTINE, ...layers))
  assert.equal(p['online-mode'], 'false') // required beats pristine
  assert.equal(p['view-distance'], '6') // later preset beats earlier
  assert.equal(p['tick-distance'], '6') // override beats preset
  assert.equal(p['max-players'], '1000') // from bench-default
  assert.equal(p['server-port'], '19210') // identity beats override
  assert.equal(p['server-portv6'], '19211')
  assert.equal(p['level-name'], 'lvl')
  assert.equal(p['content-log-console-output-enabled'], 'true')
  for (const k of Object.keys(REQUIRED_BOT_PROPERTIES)) assert.ok(k in p, k)
})

test('presets lookup and validation', () => {
  assert.deepEqual(presetProperties('vanilla-default'), {})
  assert.equal(presetProperties('bench-flat')['level-type'], 'FLAT')
  assert.equal(PRESETS['bench-default']['tick-distance'], 4)
  assert.throws(() => presetProperties('nope' as 'vanilla-default'), /unknown preset/)
  assert.throws(() => mergeServerProperties('', { a: 'x\ny' }), /newlines/)
})

test('merge rewrites every occurrence of a duplicated key', () => {
  assert.equal(mergeServerProperties('a=1\nb=2\na=3\n', { a: 9 }), 'a=9\nb=2\na=9\n')
})

test('parse ignores comments and blank lines', () => {
  assert.deepEqual(parseServerProperties('# a=b\n\nk=v \n!x=y\nempty=\n'), { k: 'v', empty: '' })
})
