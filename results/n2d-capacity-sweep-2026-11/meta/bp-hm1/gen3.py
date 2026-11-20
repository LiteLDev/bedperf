#!/usr/bin/env python3
"""Sweep configs: +2 bots every 3 min (180 s hold, no settle) until the 3-min mean TPS < 15. One config per flavor
(identical bench config, only `server` differs) and one placement profile per N."""
import json, sys, copy, os
E = os.path.expanduser('~/bpx')
mode = sys.argv[1]  # sweep | sweep-smoke
base = json.load(open(f'{E}/src/packages/orchestrator/presets/standard.json'))
base['bdsVersion'] = '1.26.60.6'
base['name'] = 'n2d-sweep'
base['loadgen'].update({'botsPerWorker': 1, 'joinIntervalMs': 500, 'connectRetries': 3})
# bedboo decodes chunks inline: isolated 50-100 ms event-loop spikes at low worker CPU are not saturation
base['loadgen']['saturation'] = {'eventLoopP99Ms': 250}
# 3 min per step: 15 s settle (the 2 new bots join and load their view; a joining worker blocks its event loop),
# then a 165 s hold
base['ramp'].update({'start': 2, 'step': 2, 'max': 600, 'resolution': 0, 'settleSec': 15, 'holdSec': 165})
base['ramp']['settle'] = {'mode': 'fixed'}
base['criteria'] = {'minAvgTps': 15, 'minWorstWindowTps': 0, 'maxTickIntervalP99Ms': 1000000, 'maxBotFailures': 1000000}
# isolated bot-client stalls are not saturation: tolerate up to 5% saturated reports per hold
base['gates'] = {'loadgenSaturatedMaxFraction': 0.05}
base['repeats'] = 1
if mode == 'sweep-smoke':
    base['name'] = 'n2d-sweep-smoke'; base['ramp'].update({'max': 4, 'holdSec': 30}); base['warmupSec'] = 20; base['cooldownSec'] = 10
FLAVORS = {
    'bds': {'flavor': 'bds', 'mods': [], 'runtime': 'native', 'versions': {}},
    'endstone': {'flavor': 'endstone', 'mods': [], 'runtime': 'native', 'versions': {}},
    'bds-wine': {'flavor': 'bds', 'mods': [], 'runtime': 'wine', 'versions': {}},
    'levilamina-wine': {'flavor': 'levilamina', 'mods': [], 'runtime': 'wine', 'versions': {}},
    'levilamina-levioptimize-wine': {'flavor': 'levilamina', 'mods': ['levioptimize'], 'runtime': 'wine', 'versions': {}},
}
d = f'{E}/cfg/{mode}'; os.makedirs(d, exist_ok=True)
for name, spec in FLAVORS.items():
    c = copy.deepcopy(base); c['server'] = spec
    json.dump(c, open(f'{d}/{name}.json', 'w'), indent=2)
# n2d-standard-32: CPU c and c+16 are SMT siblings. Server from core 0 up; harness on core 15 (15,31).
for n in [1, 2, 4, 8, 16, 32]:
    cores = list(range(max(1, n // 2)))
    cpus = [0] if n == 1 else cores + [c + 16 for c in cores]
    prof = {'label': f'n2d-standard-32 server {n} vCPU', 'placement': {
        'serverCpus': ','.join(map(str, sorted(cpus))), 'botCpus': 'auto', 'harnessCpus': '15,31', 'priority': 'normal'}}
    json.dump(prof, open(f'{d}/profile-{n}.json', 'w'), indent=2)
print('wrote', sorted(os.listdir(d)))
