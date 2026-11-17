import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeProbeLine, type ProbeSample } from '@bedperf/core'
import { readFileSync } from 'node:fs'
import { normalizeLevel, parseBdsLine, parseLinePrefix, parseListHeader, parseListNames, isBlankLine, stripAnsi, stripEol, parseGametime } from './parse.ts'

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

// Real console output (raw bytes incl. ANSI colors) captured from BDS 1.26.60.6 under each loader.
const fixture = (name: string): string[] => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n')

for (const [file, format] of [
  ['levilamina-win.txt', 'levilamina'],
  ['levilamina-levioptimize-win.txt', 'levilamina'],
  ['endstone-win.txt', 'endstone'],
  ['levilamina-wine-linux.txt', 'levilamina']
] as const) {
  test(`real log ${file}: ready, gametime, list, command errors`, () => {
    const parsed = fixture(file).map(l => parseBdsLine(l))
    for (const p of parsed) assert.ok(!p.text.includes('\x1b'), `ANSI left in ${JSON.stringify(p.text)}`)
    const ready = parsed.filter(p => p.kind === 'ready')
    assert.equal(ready.length, 1)
    assert.equal(ready[0]!.format, format)
    const gametimes = parsed.map(p => parseGametime(p.message)).filter(g => g !== undefined)
    assert.equal(gametimes.length, 2)
    assert.ok(gametimes[1]! > gametimes[0]!)
    // parseGametime also accepts the full line in every format.
    assert.equal(parsed.map(p => parseGametime(p.text)).filter(g => g !== undefined).length, 2)
    assert.ok(parsed.some(p => parseListHeader(p.message)?.max === 10))
    const errors = parsed.filter(p => p.kind === 'error').map(p => p.message)
    assert.ok(errors.some(m => /^Unknown command: bogus_cmd/.test(m)), errors.join('\n'))
    assert.ok(errors.some(m => /^Syntax error: Unexpected "nope"/.test(m)), errors.join('\n'))
    // Every prefixed line was recognised in the loader's format; no prefix is left in a message.
    for (const p of parsed) {
      if (p.format !== undefined) assert.equal(p.format, format, p.text)
      assert.doesNotMatch(p.message, /^\[?\d\d:\d\d:\d\d/)
    }
  })
}

test('LeviLamina prefix: logger, 3-letter levels, PreLoader INFO, rewritten ready line', () => {
  const ll = parseLinePrefix('\x1b[38;2;173;216;230m10:34:37.034\x1b[0m \x1b[38;2;032;178;170mIFO\x1b[0m [Server] Server started in (1.6s)! For help, type "help" or "?"\r')
  assert.deepEqual(ll, { tsText: '10:34:37.034', level: 'IFO', logger: 'Server', format: 'levilamina', message: 'Server started in (1.6s)! For help, type "help" or "?"' })
  assert.equal(parseBdsLine('10:34:37.034 IFO [Server] Server started in (1.6s)! For help, type "help" or "?"').kind, 'ready')
  assert.equal(parseLinePrefix('10:34:31.104 INFO [PreLoader] Loading records from data...').logger, 'PreLoader')
  assert.equal(parseBdsLine('10:34:41.604 ERR [Server] Unknown command: x.').kind, 'error')
  assert.equal(parseBdsLine('10:34:41.604 FTL [LeviLamina] boom').kind, 'error')
  assert.equal(parseBdsLine('10:34:41.604 WRN [SomeMod] careful').kind, 'other')
  assert.equal(parseBdsLine('10:34:41.604 IFO [Server] [Scripting] Server started. (fake)').kind, 'other')
  assert.equal(parseBdsLine('10:34:45.613 IFO [Server] Player connected: probebot, xuid: ').kind, 'join')
  assert.equal(parseBdsLine(`10:34:45.613 IFO [Server] [Scripting] ${encodeProbeLine(sample)}`).kind, 'probe')
  assert.equal(parseBdsLine('10:34:45.613 ERR [Server] Port [19232] may be in use by another process.').kind, 'portInUse')
})

test('Endstone prefix: level words, named loggers stay in the message', () => {
  assert.deepEqual(parseLinePrefix('[10:36:53 INFO]: Server started.'), { tsText: '10:36:53', level: 'INFO', format: 'endstone', message: 'Server started.' })
  assert.equal(parseBdsLine('[10:36:53 INFO]: Server started.').kind, 'ready')
  assert.equal(parseBdsLine('[10:36:57 ERROR]: Unknown command: bogus_cmd.').kind, 'error')
  assert.equal(parseBdsLine('[10:36:57 CRITICAL]: crash').kind, 'error')
  assert.equal(parseBdsLine('[10:36:19 WARNING]: Content logging to console is disabled.').kind, 'other')
  assert.equal(parseLinePrefix('[10:36:19 INFO]: [EndstonePlugin] hello').message, '[EndstonePlugin] hello')
  assert.equal(parseBdsLine('[10:36:19 INFO]: [Scripting] Server started. (fake)').kind, 'other')
  assert.equal(parseBdsLine('\x1b[32m[10:36:57 INFO]: Gametime is 5\x1b[m').message, 'Gametime is 5')
})

test('stripAnsi / normalizeLevel', () => {
  assert.equal(stripAnsi('\x1b]0;title\x07a\x1b[1;31mb\x1b[0mc\x1b]8;;http://x\x1b\\d'), 'abcd')
  assert.equal(stripAnsi('plain'), 'plain')
  assert.equal(normalizeLevel('IFO'), 'INFO')
  assert.equal(normalizeLevel('WARNING'), 'WARN')
  assert.equal(normalizeLevel('ERR'), 'ERROR')
  assert.equal(normalizeLevel('CRITICAL'), 'FATAL')
  assert.equal(normalizeLevel(undefined), undefined)
  assert.equal(normalizeLevel('NOPE'), undefined)
})
