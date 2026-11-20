#!/usr/bin/env python3
"""Per valid sweep run: 1-minute bins (bots, TPS, tick p99, CPU, main util, RSS, bot CPU) + summary. Prints JSON lines."""
import json, glob, os, socket, statistics as S
from collections import defaultdict
import sys
H = sys.argv[1]; HOST = sys.argv[2]
for res in sorted(glob.glob(H + '/N*/*/r*/2*/result.json')):
    d = os.path.dirname(res); parts = d.replace(chr(92), '/').split('/')
    n, flavor, rep = int(parts[-4][1:]), parts[-3], int(parts[-2][1:])
    r = json.load(open(res))
    if r.get('invalidLimited') or not any(x.get('status') == 'ok' for x in r.get('repeats', [])): continue
    cfg = json.load(open(d + '/config.json')); meta = json.load(open(d + '/meta.json'))
    t0 = None; bins = defaultdict(lambda: defaultdict(list)); steps = []
    for l in open(d + '/samples.jsonl'):
        e = json.loads(l); k = e.get('kind'); x = e.get('data') or {}; t = e.get('t', 0)
        if k == 'orch.repeat.start' and t0 is None: t0 = t; continue
        if t0 is None: continue
        b = int((t - t0) / 60000); f = bins[b]
        if k == 'probe.sample' and x.get('windowMs'):
            f['tps'].append(x.get('tps') or 0); f['p99'].append((x.get('interval') or {}).get('p99') or 0)
        elif k == 'sys.sample':
            f['cpu'].append((x.get('cpuPct') or 0) / 100); f['main'].append(((x.get('mainThread') or {}).get('util') or 0))
            f['rss'].append((x.get('rssBytes') or 0) / 2**20)
        elif k == 'bot.stats':
            f['bots'].append(x.get('spawned') or 0); f['botcpu'].append(((x.get('loadgen') or {}).get('totalCores') or 0))
        elif k == 'orch.step.end':
            steps.append({'players': x.get('players'), 'tps': round(((x.get('tps') or {}).get('mean') or 0), 3) if isinstance(x.get('tps'), dict) else None})
    series = []
    for b in sorted(bins):
        f = bins[b]
        if not f['bots'] or not f['tps']: continue
        series.append([b, max(f['bots']), round(S.mean(f['tps']), 3), round(max(f['p99']), 1), round(S.mean(f['cpu']), 3) if f['cpu'] else None,
                       round(S.mean(f['main']), 3) if f['main'] else None, round(max(f['rss'])) if f['rss'] else None, round(S.mean(f['botcpu']), 2)])
    st = [s for s in json.load(open(d + '/steps.json')) if not s.get('invalidReasons')]
    srv = meta.get('server') or {}
    print(json.dumps({'n': n, 'flavor': flavor, 'rep': rep, 'host': HOST, 'run': os.path.basename(d),
                      'max': max(r.get('maxPlayers') or [0]), 'steps': len(st), 'invalidSteps': sum(1 for s in json.load(open(d + '/steps.json')) if s.get('invalidReasons')),
                      'rssPeakMB': round(max(((s.get('rssBytes') or {}).get('max') or 0) for s in st) / 2**20),
                      'serverCpus': (meta.get('placement') or {}).get('serverCpus'), 'harnessCpus': (meta.get('placement') or {}).get('harnessCpus'),
                      'bds': srv.get('bdsVersion'), 'artifacts': [(a.get('name'), a.get('version')) for a in (srv.get('artifacts') or [])],
                      'botsPerWorker': cfg['loadgen'].get('botsPerWorker'), 'settleSec': cfg['ramp'].get('settleSec'), 'holdSec': cfg['ramp'].get('holdSec'),
                      'satFrac': (cfg.get('gates') or {}).get('loadgenSaturatedMaxFraction'), 'lagMs': (cfg['loadgen'].get('saturation') or {}).get('eventLoopP99Ms'),
                      'harness': (meta.get('harness') or {}).get('git') if isinstance(meta.get('harness'), dict) else meta.get('harness'),
                      'series': series}))
