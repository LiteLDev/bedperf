#!/usr/bin/env python3
"""Build the dashboard's data files from extract_local.py output (final-<host>.jsonl, one JSON object per valid run).
runs.json: one row per run. curves.json: one row per run-minute. Each is {rows, meta}; meta carries this code."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
LABEL = {'bds': 'BDS', 'endstone': 'Endstone', 'bds-wine': 'BDS (Wine)', 'levilamina-wine': 'LeviLamina (Wine)',
         'levilamina-levioptimize-wine': 'LeviLamina+LeviOptimize (Wine)'}
HOST = {'bp-hm1': 'hm1', 'bp-z1': 'z1', 'bp-z2': 'z2'}
runs, curves = [], []
for h in ('bp-hm1', 'bp-z1', 'bp-z2'):
    for line in open(os.path.join(HERE, f'final-{h}.jsonl')):
        r = json.loads(line)
        key = f"{r['n']}|{LABEL[r['flavor']]}|{r['rep']}"
        early = []
        if r['settleSec'] == 0: early.append('no 15 s settle (180 s hold)')
        if r['botsPerWorker'] == 2: early.append('2 bots per worker')
        if r['lagMs'] is None: early.append('lag threshold 50 ms')
        if r['satFrac'] is None: early.append('any saturated second invalid')
        runs.append({'run': key, 'vcpu': r['n'], 'server': LABEL[r['flavor']], 'rep': r['rep'], 'maxBots': r['max'],
                     'rssPeakGiB': round(r['rssPeakMB'] / 1024, 2), 'memLimitGiB': 8 * r['n'],
                     'steps': r['steps'], 'invalidSteps': r['invalidSteps'], 'machine': HOST[h],
                     'serverCpus': ','.join(map(str, r['serverCpus'])), 'method': 'final' if not early else 'early: ' + '; '.join(early),
                     'runDir': r['run'], 'harnessCommit': (r['harness'] or '')[:12]})
        for m, bots, tps, p99, cpu, main, rss, botcpu in r['series']:
            curves.append({'run': key, 'vcpu': r['n'], 'server': LABEL[r['flavor']], 'rep': r['rep'], 'minute': m, 'bots': bots,
                           'tps': tps, 'tickP99Ms': p99, 'serverCores': cpu, 'mainThreadUtil': main, 'rssMiB': rss, 'botCores': botcpu})
runs.sort(key=lambda x: (x['vcpu'], x['server'], x['rep'])); curves.sort(key=lambda x: (x['vcpu'], x['server'], x['rep'], x['minute']))
code = [{'label': 'build_data.py', 'value': open(__file__).read(), 'type': 'code', 'lang': 'python'},
        {'label': 'extract_local.py (per-run extraction from bedperf samples.jsonl)', 'value': open(os.path.join(HERE, 'extract_local.py')).read(), 'type': 'code', 'lang': 'python'},
        {'label': 'Input', 'value': 'bedperf run dirs runs/sweep/N<vcpu>/<flavor>/r<rep>/<run>/ from bp-hm1, bp-z1, bp-z2 (archived as bp-*.tar.xz)'}]
json.dump({'rows': runs, 'meta': code}, open(os.path.join(HERE, 'runs.json'), 'w'), separators=(',', ':'))
json.dump({'rows': curves, 'meta': code}, open(os.path.join(HERE, 'curves.json'), 'w'), separators=(',', ':'))
print(len(runs), 'runs,', len(curves), 'curve rows')
