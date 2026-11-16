import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeProbeLine, type ProbeSample } from '@bedperf/core'
import { parseBdsLine, parseLinePrefix, parseListHeader, parseListNames, isBlankLine, stripEol, parseGametime } from './parse.ts'

const sample: ProbeSample = {
  type: 'sample', v: 1, tick: 100, t: 1, windowMs: 1000, ticks: 20, tps: 20,
  interval: { mean: 50, max: 52, p50: 50, p95: 51, p99: 52 }, over50: 0, over100: 0, players: 1
}

test('prefix: timestamp with milliseconds and level', () => {
  const p = parseLinePrefix('[2026-11-16 16:15:28:495 INFO] Server started.')
  assert.equal(p.level, 'INFO')
  assert.equal(p.message, 'Server started.')
  assert.equal(p.tsText, '2026-11-16 16:15:28:495')
  assert.equal(p.ts, new Date(2026, 10, 16, 16, 15, 28, 495).getTime())
})

test('prefix: Windows CR, level-only, no-ms and missing prefix', () => {
  const crlf = parseLinePrefix('[2026-11-16 16:15:28:495 WARN] hello\r')
  assert.equal(crlf.message, 'hello')
  assert.equal(crlf.level, 'WARN')

  const levelOnly = parseLinePrefix('[INFO] Server started.')
  assert.equal(levelOnly.level, 'INFO')
  assert.equal(levelOnly.ts, undefined)
  assert.equal(levelOnly.message, 'Server started.')

  const noMs = parseLinePrefix('[2026-11-16 16:15:28 ERROR] boom')
  assert.equal(noMs.ts, new Date(2026, 10, 16, 16, 15, 28, 0).getTime())
  assert.equal(noMs.level, 'ERROR')

  const bare = parseLinePrefix('Quit correctly\r\n')
  assert.deepEqual(bare, { message: 'Quit correctly' })

  assert.equal(parseLinePrefix('#####################').level, undefined)
  // Only known levels count: an unprefixed `[Scripting]` tag is part of the message.
  const tag = parseLinePrefix('[Scripting] Server started.')
  assert.equal(tag.level, undefined)
  assert.equal(tag.message, '[Scripting] Server started.')
  assert.equal(parseBdsLine('[Scripting] Server started.').kind, 'other')
})

test('stripEol / isBlankLine', () => {
  assert.equal(stripEol('a\r\n'), 'a')
  assert.equal(stripEol('a\r'), 'a')
  assert.ok(isBlankLine(parseLinePrefix('')))
  assert.ok(isBlankLine(parseLinePrefix('\r')))
  assert.ok(isBlankLine(parseLinePrefix('[2026-11-16 16:19:35:655 INFO] ')))
  assert.ok(!isBlankLine(parseLinePrefix('x')))
})

test('ready', () => {
  const p = parseBdsLine('[2026-11-16 16:19:37:096 INFO] Server started.\r')
  assert.equal(p.kind, 'ready')
  assert.equal(p.text, '[2026-11-16 16:19:37:096 INFO] Server started.')
  assert.equal(parseBdsLine('Server started.').kind, 'ready')
  assert.equal(parseBdsLine('[2026-11-16 16:19:37:096 INFO] [Scripting] Server started. (fake)').kind, 'other')
})

test('player join / leave with and without xuid', () => {
  const j = parseBdsLine('[2026-11-16 16:19:45:613 INFO] Player connected: probebot, xuid: \r')
  assert.equal(j.kind, 'join')
  assert.deepEqual(j.kind === 'join' && j.player, { name: 'probebot' })

  const j2 = parseBdsLine('[2026-11-16 16:19:45:613 INFO] Player connected: Some Name, xuid: 2535412345678901')
  assert.deepEqual(j2.kind === 'join' && j2.player, { name: 'Some Name', xuid: '2535412345678901' })

  const l = parseBdsLine('[2026-11-16 16:19:51:461 INFO] Player disconnected: probebot, xuid: , pfid: ')
  assert.equal(l.kind, 'leave')
  assert.deepEqual(l.kind === 'leave' && l.player, { name: 'probebot' })

  const l2 = parseBdsLine('Player disconnected: a, b, xuid: 123, pfid: abc')
  assert.deepEqual(l2.kind === 'leave' && l2.player, { name: 'a, b', xuid: '123' })

  // Not a join: spawn line, scripting echo.
  assert.equal(parseBdsLine('[2026-11-16 16:19:47:179 INFO] Player Spawned: probebot xuid: , pfid: ').kind, 'other')
  assert.equal(parseBdsLine('[2026-11-16 16:19:47:179 INFO] [Scripting] Player connected: x, xuid: 1').kind, 'other')
})

test('probe lines with a [Scripting] prefix, CR and trailing blanks', () => {
  const line = `[2026-11-16 10:00:00:000 INFO] [Scripting] ${encodeProbeLine(sample)}\r`
  const p = parseBdsLine(line)
  assert.equal(p.kind, 'probe')
  assert.deepEqual(p.kind === 'probe' && p.record, sample)
  assert.equal(p.level, 'INFO')

  const bare = parseBdsLine(encodeProbeLine({ type: 'pong', v: 1, tick: 5, t: 6, id: 'abc' }))
  assert.deepEqual(bare.kind === 'probe' && bare.record, { type: 'pong', v: 1, tick: 5, t: 6, id: 'abc' })

  assert.equal(parseBdsLine('[2026-11-16 10:00:00:000 INFO] [Scripting] BEDPERF|{broken').kind, 'other')
  assert.equal(parseBdsLine('[2026-11-16 10:00:00:000 ERROR] [Scripting] BEDPERF|{"type":"x"}').kind, 'error')
})

test('port in use', () => {
  const p = parseBdsLine('[2026-11-16 16:20:12:699 ERROR] Port [19232] may be in use by another process. Free up port and re-run program or adjust server.properties file to use alternate ports for server\r')
  assert.equal(p.kind, 'portInUse')
  assert.equal(p.kind === 'portInUse' && p.port, 19232)
  assert.equal(parseBdsLine('Port [..] may be in use').kind, 'portInUse')
})

test('error and other', () => {
  assert.equal(parseBdsLine('[2026-11-16 16:19:41:986 ERROR] Unknown command: foo.').kind, 'error')
  assert.equal(parseBdsLine('[2026-11-16 16:20:12:699 ERROR] Exiting program').kind, 'error')
  assert.equal(parseBdsLine('[2026-11-16 16:19:37:217 INFO] There are 0/10 players online:').kind, 'other')
  assert.equal(parseBdsLine('NO LOG FILE! - setting up server logging...').kind, 'other')
  const blank = parseBdsLine('\r')
  assert.equal(blank.kind, 'other')
  assert.equal(blank.text, '')
})

test('list parsing', () => {
  assert.deepEqual(parseListHeader('There are 3/10 players online:'), { online: 3, max: 10 })
  assert.equal(parseListHeader('There are players'), undefined)
  assert.deepEqual(parseListNames('a, b c, d\r'), ['a', 'b c', 'd'])
  assert.deepEqual(parseListNames(''), [])
})

test('parseGametime reads `time query gametime` replies', () => {
  assert.equal(parseGametime('[2026-11-16 16:15:28:495 INFO] Gametime is 12345\r'), 12345)
  assert.equal(parseGametime('[2026-11-16 16:15:28 INFO] Gametime is 0'), 0)
  assert.equal(parseGametime('Gametime is 987654321'), 987654321)
  assert.equal(parseGametime('gametime is 42'), 42)
  // Other `time query` answers and unrelated lines are not gametime replies.
  assert.equal(parseGametime('[2026-11-16 16:15:28:495 INFO] Daytime is 1000'), undefined)
  assert.equal(parseGametime('[2026-11-16 16:15:28:495 INFO] Day is 3'), undefined)
  assert.equal(parseGametime('[2026-11-16 16:15:28:495 INFO] [Scripting] Gametime is 5'), undefined)
  assert.equal(parseGametime('[2026-11-16 16:15:28:495 ERROR] Syntax error: Unexpected "x": at "query >>x<<"'), undefined)
  assert.equal(parseGametime(''), undefined)
  assert.equal(parseGametime('Gametime is 99999999999999999999'), undefined)
})
