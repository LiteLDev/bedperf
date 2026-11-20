#!/usr/bin/env python3
"""Build a flat, offline dataset from the bedperf n2d experiment archives.

Usage: python build_dataset.py <extracted-root> <out-dir> [report-runs.json]

<extracted-root> holds one sub-directory per archive, each the result of extracting it:
  bp-hm1/  bp-z1/  bp-z2/   <- bp-*.tar.xz  (the 90-job sweep, plus old/ = voided / stopped / re-run attempts)
  old-n2d/                  <- old-runs.tgz (17 Nov core-scan / smoke runs on the first n2d pair)
Every directory holding a samples.jsonl is treated as one bedperf run.
"""
import csv, glob, gzip, json, os, re, statistics as S, sys
from collections import defaultdict
from multiprocessing import Pool

ROOT, OUT = sys.argv[1], sys.argv[2]
REPORT_RUNS = sys.argv[3] if len(sys.argv) > 3 else None
LABEL = {'bds': 'BDS', 'endstone': 'Endstone', 'bds-wine': 'BDS (Wine)', 'levilamina-wine': 'LeviLamina (Wine)',
         'levilamina-levioptimize-wine': 'LeviLamina+LeviOptimize (Wine)'}
REPORT_HOST = {'hm1': 'bp-hm1', 'z1': 'bp-z1', 'z2': 'bp-z2'}


def g(d, *ks):
    for k in ks:
        if not isinstance(d, dict): return None
        d = d.get(k)
    return d


def r(x, n=3):
    return None if x is None else round(x, n)


def classify(rel):
    """rel: path of the run dir relative to ROOT, '/'-separated. Returns host, category, vcpu, flavor, rep, attempt from the path."""
    p = rel.split('/'); host = p[0]
    out = {'host': host, 'category': None, 'pathVcpu': None, 'pathFlavor': None, 'rep': None, 'attempt': None}
    m = re.search(r'/N(\d+)/([a-z-]+)/r(\d+)/', '/' + rel + '/')
    if m: out.update(pathVcpu=int(m[1]), pathFlavor=m[2], rep=int(m[3]))
    m2 = re.search(r'/N(\d+)-([a-z-]+?)-r(\d+)-([a-z0-9]+)/', '/' + rel + '/')
    if m2: out.update(pathVcpu=int(m2[1]), pathFlavor=m2[2], rep=int(m2[3]), attempt=m2[4])
    if host == 'old-n2d':
        out['category'] = 'old-n2d/' + p[2]          # full | smoke | sweep-smoke
        m3 = re.search(r'/full/N(\d+)', '/' + rel)
        if m3: out['pathVcpu'] = int(m3[1])
    elif p[1] == 'runs':
        out['category'] = 'sweep'
        cons = glob.glob(os.path.join(ROOT, *p[:-1], 'console-*-a*.log'))
        if cons: out['attempt'] = 'a' + re.search(r'-a(\d+)\.log$', cons[0])[1]
    else:
        out['category'] = 'old/' + p[2]              # invalid | wine-affinity | stopped-old-config | sweep-try1-0144
    return out


def stat(d, k):
    return g(d, k) if isinstance(d, dict) else None


STEP_COLS = ['host', 'category', 'runId', 'server', 'vcpu', 'rep', 'attempt', 'repeat', 'index', 'phase', 'players', 'pass',
             'failReasons', 'invalidReasons', 'startT', 'endT', 'settleSec', 'settleCapped',
             'tpsMean', 'tpsMin', 'tpsP50', 'tpsP95', 'counterTps', 'counterTpsLow5',
             'tickMsMean', 'tickMsP50', 'tickMsP95', 'tickMsP99', 'tickMsMax', 'over50', 'over100', 'tickCpuMsPerTick',
             'mainUtilMean', 'mainUtilP95', 'mainUtilMax', 'serverCpuPctMean', 'serverCpuPctP95', 'serverCpuPctMax',
             'rssMiBMax', 'rttMsP50', 'rttMsP95', 'rttMsP99', 'gametimeLatMsP50', 'gametimeLatMsP99', 'gametimeMaxGapMs',
             'chunksPerSec', 'uniqChunksPerBot', 'viewT90MsP50', 'inViewMedian', 'viewsIncomplete', 'netRxBps', 'netTxBps',
             'botFailures', 'loadgenSaturated', 'foreignMean', 'foreignPeak10s', 'serverSetForeignMean', 'placementVerified',
             'tickThreadSource']


def step_row(base, s):
    return dict(base, repeat=s.get('repeat'), index=s.get('index'), phase=s.get('phase'), players=s.get('players'), **{'pass': s.get('pass')},
                failReasons='; '.join(s.get('failReasons') or []), invalidReasons='; '.join(s.get('invalidReasons') or []),
                startT=s.get('startT'), endT=s.get('endT'), settleSec=r(s.get('settleSec')), settleCapped=s.get('settleCapped'),
                tpsMean=r(g(s, 'tps', 'mean')), tpsMin=r(g(s, 'tps', 'min')), tpsP50=r(g(s, 'tps', 'p50')), tpsP95=r(g(s, 'tps', 'p95')),
                counterTps=r(s.get('counterTps')), counterTpsLow5=r(s.get('counterTpsLow5')),
                tickMsMean=r(g(s, 'tickIntervalMs', 'mean')), tickMsP50=r(g(s, 'tickIntervalMs', 'p50')), tickMsP95=r(g(s, 'tickIntervalMs', 'p95')),
                tickMsP99=r(g(s, 'tickIntervalMs', 'p99')), tickMsMax=g(s, 'tickIntervalMs', 'max'), over50=s.get('over50'), over100=s.get('over100'),
                tickCpuMsPerTick=r(s.get('tickCpuMsPerTick')),
                mainUtilMean=r(g(s, 'mainThreadUtil', 'mean'), 4), mainUtilP95=r(g(s, 'mainThreadUtil', 'p95'), 4), mainUtilMax=r(g(s, 'mainThreadUtil', 'max'), 4),
                serverCpuPctMean=r(g(s, 'cpuPct', 'mean'), 2), serverCpuPctP95=r(g(s, 'cpuPct', 'p95'), 2), serverCpuPctMax=r(g(s, 'cpuPct', 'max'), 2),
                rssMiBMax=r((g(s, 'rssBytes', 'max') or 0) / 2**20, 1) if g(s, 'rssBytes', 'max') else None,
                rttMsP50=r(g(s, 'rttMs', 'p50'), 2), rttMsP95=r(g(s, 'rttMs', 'p95'), 2), rttMsP99=r(g(s, 'rttMs', 'p99'), 2),
                gametimeLatMsP50=r(g(s, 'gametimeLatencyMs', 'p50'), 2), gametimeLatMsP99=r(g(s, 'gametimeLatencyMs', 'p99'), 2),
                gametimeMaxGapMs=r(s.get('gametimeMaxGapMs'), 1), chunksPerSec=r(s.get('chunksPerSec')), uniqChunksPerBot=r(s.get('uniqChunksPerBot'), 1),
                viewT90MsP50=r(s.get('viewT90MsP50'), 1), inViewMedian=s.get('inViewMedian'), viewsIncomplete=s.get('viewsIncomplete'),
                netRxBps=r(s.get('netRxBytesPerSec'), 0), netTxBps=r(s.get('netTxBytesPerSec'), 0), botFailures=s.get('botFailures'),
                loadgenSaturated=s.get('loadgenSaturated'), foreignMean=r(g(s, 'interference', 'foreignMean'), 2),
                foreignPeak10s=r(g(s, 'interference', 'foreignPeak10s'), 2), serverSetForeignMean=r(g(s, 'interference', 'serverSetForeignMean'), 4),
                placementVerified=s.get('placementVerified'), tickThreadSource=s.get('tickThreadSource'))


TS_COLS = ['host', 'category', 'runId', 'server', 'vcpu', 'rep', 'attempt', 'repeat', 'binSec', 'tSec', 'wallUtc', 'stepPlayers', 'stepState',
           'botsTarget', 'botsConnected', 'botsSpawned', 'joinFailures', 'unexpectedDisconnects', 'connectRetries',
           'tpsMean', 'tpsMin', 'tickMsP99Max', 'tickMsMax', 'over100', 'gametimeLatMsMax',
           'serverCores', 'mainUtilMean', 'mainUtilMax', 'rssMiB', 'privateMiB', 'threads', 'systemCpuPct', 'srvNetRxBps', 'srvNetTxBps',
           'botCores', 'botRssMiB', 'botEventLoopLagP99Ms', 'botMaxWorkerCpuPct', 'loadgenSaturatedFrac', 'botRttMsP50', 'botRxBps',
           'correctionsPerSec', 'srvHostBusyCores', 'srvHostForeignCores', 'srvSetForeignCores', 'agentBusyCores', 'agentForeignCores',
           'agentSaturatedFrac']


def mean(xs): return S.mean(xs) if xs else None


def process(rundir):
    rel = os.path.relpath(rundir, ROOT).replace('\\', '/')
    c = classify(rel)
    cfg = json.load(open(os.path.join(rundir, 'config.json'))) if os.path.exists(os.path.join(rundir, 'config.json')) else {}
    meta = json.load(open(os.path.join(rundir, 'meta.json'))) if os.path.exists(os.path.join(rundir, 'meta.json')) else {}
    res = json.load(open(os.path.join(rundir, 'result.json'))) if os.path.exists(os.path.join(rundir, 'result.json')) else None
    label = (g(meta, 'server', 'label') or '').lower().replace(' (wine)', '-wine').replace('+', '-')
    flavor = c['pathFlavor'] or label or g(cfg, 'server', 'flavor')
    server = LABEL.get(flavor, flavor)
    srv_cpus = g(meta, 'placement', 'serverCpus') or [x for x in str(g(cfg, 'placement', 'serverCpus') or '').split(',') if x]
    vcpu = len(srv_cpus) if srv_cpus else c['pathVcpu']
    base = {'host': c['host'], 'category': c['category'], 'runId': os.path.basename(rundir), 'server': server, 'vcpu': vcpu,
            'rep': c['rep'], 'attempt': c['attempt']}

    # ---- one pass over samples.jsonl ----
    bins10, bins60 = defaultdict(lambda: defaultdict(list)), defaultdict(lambda: defaultdict(list))
    rep_t0 = {}; repeat = None; t0 = None; first_t = last_t = None
    step_players = None; step_state = 'warmup'
    step_events = []; thread_samples = []; kinds = defaultdict(int); bds_events = []; commands = []; placement_issues = 0
    for line in open(os.path.join(rundir, 'samples.jsonl'), encoding='utf8'):
        try: e = json.loads(line)
        except ValueError: continue
        k = e.get('kind'); x = e.get('data') or {}; t = e.get('t') or 0
        kinds[k] += 1
        if first_t is None: first_t = t
        last_t = t
        if k == 'orch.repeat.start':
            repeat = x.get('repeat'); t0 = t; rep_t0[repeat] = t; step_players = None; step_state = 'warmup'; continue
        if k == 'orch.step.start': step_players = x.get('players'); step_state = 'settle'
        elif k == 'orch.settle': step_state = 'measure'
        elif k == 'orch.step.end': step_state = 'gap'; step_events.append(x)
        elif k == 'bds.event': bds_events.append(x.get('event'))
        elif k == 'orch.command': commands.append(x.get('command'))
        elif k == 'orch.placement.verify' and x.get('issues'): placement_issues += 1
        if t0 is None: continue
        sec = (t - t0) / 1000
        for bins, w in ((bins10, 10), (bins60, 60)):
            f = bins[(repeat, int(sec // w))]
            if not f['_n']: f['_wall'].append(t); f['_sp'].append(step_players); f['_st'].append(step_state)
            f['_n'].append(1)
            if k == 'probe.sample' and x.get('windowMs'):
                f['tps'].append(x.get('tps') or 0); f['p99'].append(g(x, 'interval', 'p99') or 0); f['tmax'].append(g(x, 'interval', 'max') or 0)
                f['o100'].append(x.get('over100') or 0)
            elif k == 'sys.sample':
                f['cpu'].append((x.get('cpuPct') or 0) / 100); f['main'].append(g(x, 'mainThread', 'util') or 0)
                f['rss'].append((x.get('rssBytes') or 0) / 2**20); f['priv'].append((x.get('privateBytes') or 0) / 2**20)
                f['thr'].append(x.get('threadCount') or 0); f['syscpu'].append(x.get('systemCpuPct') or 0)
                f['nrx'].append(g(x, 'net', 'rxBytesPerSec') or 0); f['ntx'].append(g(x, 'net', 'txBytesPerSec') or 0)
            elif k == 'sys.interference':
                f['hbusy'].append(x.get('busyCores') or 0); f['hfor'].append(x.get('foreignCores') or 0)
                f['ssf'].append(x.get('serverSetForeignCores') or 0)
            elif k == 'agent.telemetry':
                f['abusy'].append(x.get('busyCores') or 0); f['afor'].append(x.get('foreignCores') or 0); f['asat'].append(1 if x.get('saturated') else 0)
            elif k == 'bot.stats':
                lg = x.get('loadgen') or {}
                f['tgt'].append(x.get('target') or 0); f['con'].append(x.get('connected') or 0); f['spw'].append(x.get('spawned') or 0)
                f['jf'].append(x.get('joinFailures') or 0); f['ud'].append(x.get('unexpectedDisconnects') or 0); f['cr'].append(x.get('connectRetries') or 0)
                f['bcores'].append(lg.get('totalCores') or 0); f['brss'].append((lg.get('rssBytes') or 0) / 2**20)
                f['lag'].append(lg.get('eventLoopLagP99Ms') or 0); f['wcpu'].append(lg.get('maxWorkerCpuPct') or 0)
                f['lsat'].append(1 if lg.get('saturated') else 0)
                if g(x, 'rttMs', 'p50') is not None: f['rtt'].append(g(x, 'rttMs', 'p50'))
                f['brx'].append(x.get('rxBytesPerSec') or 0); f['corr'].append(x.get('correctionsPerSec') or 0)
            elif k == 'bds.gametime':
                f['gt'].append(x.get('latencyMs') or 0)
        if k == 'sys.sample' and x.get('threads'):
            agg = defaultdict(float)
            for th in x['threads']: agg[th.get('name') or '?'] += th.get('cpuPct') or 0
            thread_samples.append((t, repeat, dict(agg)))

    def ts_rows(bins, w):
        out = []
        for (rp, b) in sorted(bins, key=lambda z: (z[0] if z[0] is not None else -1, z[1])):
            f = bins[(rp, b)]
            last = lambda key: f[key][-1] if f[key] else None
            out.append(dict(base, repeat=rp, binSec=w, tSec=b * w,
                            wallUtc=__import__('datetime').datetime.utcfromtimestamp(f['_wall'][0] / 1000).strftime('%Y-%m-%dT%H:%M:%SZ'),
                            stepPlayers=f['_sp'][0], stepState=f['_st'][0],
                            botsTarget=last('tgt'), botsConnected=last('con'), botsSpawned=max(f['spw']) if f['spw'] else None,
                            joinFailures=last('jf'), unexpectedDisconnects=last('ud'), connectRetries=last('cr'),
                            tpsMean=r(mean(f['tps'])), tpsMin=r(min(f['tps'])) if f['tps'] else None,
                            tickMsP99Max=r(max(f['p99']), 1) if f['p99'] else None, tickMsMax=max(f['tmax']) if f['tmax'] else None,
                            over100=sum(f['o100']) if f['o100'] else None, gametimeLatMsMax=r(max(f['gt']), 1) if f['gt'] else None,
                            serverCores=r(mean(f['cpu'])), mainUtilMean=r(mean(f['main']), 4), mainUtilMax=r(max(f['main']), 4) if f['main'] else None,
                            rssMiB=r(max(f['rss']), 1) if f['rss'] else None, privateMiB=r(max(f['priv']), 1) if f['priv'] else None,
                            threads=max(f['thr']) if f['thr'] else None, systemCpuPct=r(mean(f['syscpu']), 2),
                            srvNetRxBps=r(mean(f['nrx']), 0), srvNetTxBps=r(mean(f['ntx']), 0),
                            botCores=r(mean(f['bcores'])), botRssMiB=r(max(f['brss']), 0) if f['brss'] else None,
                            botEventLoopLagP99Ms=r(max(f['lag']), 2) if f['lag'] else None, botMaxWorkerCpuPct=r(max(f['wcpu']), 2) if f['wcpu'] else None,
                            loadgenSaturatedFrac=r(mean(f['lsat'])), botRttMsP50=r(mean(f['rtt']), 2), botRxBps=r(mean(f['brx']), 0),
                            correctionsPerSec=r(mean(f['corr'])), srvHostBusyCores=r(mean(f['hbusy']), 2), srvHostForeignCores=r(mean(f['hfor']), 2),
                            srvSetForeignCores=r(mean(f['ssf']), 4), agentBusyCores=r(mean(f['abusy']), 2), agentForeignCores=r(mean(f['afor']), 2),
                            agentSaturatedFrac=r(mean(f['asat']))))
        return out

    # ---- steps: steps.json when present (has post-hoc stats), else orch.step.end events ----
    sp = os.path.join(rundir, 'steps.json')
    steps = json.load(open(sp)) if os.path.exists(sp) else step_events
    steps_src = 'steps.json' if os.path.exists(sp) else 'orch.step.end'
    step_rows = [step_row(base, s) for s in steps]

    # ---- per-thread CPU inside each step's measurement window (sys.sample keeps only the top-5 threads) ----
    thread_rows = []
    for s in steps:
        a, b = s.get('startT'), s.get('endT')
        if a is None or b is None: continue
        win = [ts for ts in thread_samples if a <= ts[0] <= b and (ts[1] == s.get('repeat') or ts[1] is None)]
        if not win: continue
        names = defaultdict(float)
        for _, _, agg in win:
            for n, v in agg.items(): names[n] += v
        for n, tot in sorted(names.items(), key=lambda z: -z[1]):
            thread_rows.append(dict(base, repeat=s.get('repeat'), index=s.get('index'), players=s.get('players'), threadName=n,
                                    cpuPctMean=r(tot / len(win), 2), samples=len(win)))

    # ---- run summary ----
    valid_steps = [s for s in steps if not s.get('invalidReasons')]
    def at_players(p):
        for s in valid_steps:
            if s.get('players') == p: return s
    reps = (res or {}).get('repeats') or []
    mx = max((res or {}).get('maxPlayers') or [0]) if res else None
    cap = at_players(mx) if mx else None
    fails = [s for s in valid_steps if s.get('pass') is False]
    ff = fails[0] if fails else None
    early = []
    lg = cfg.get('loadgen') or {}; rp = cfg.get('ramp') or {}
    if rp.get('settleSec') == 0: early.append('no 15 s settle (180 s hold)')
    if lg.get('botsPerWorker') == 2: early.append('2 bots per worker')
    if (lg.get('saturation') or {}).get('eventLoopP99Ms') is None: early.append('lag threshold 50 ms (default)')
    if (cfg.get('gates') or {}).get('loadgenSaturatedMaxFraction') is None: early.append('any saturated second invalid')
    rss_all = [g(s, 'rssBytes', 'max') for s in steps if g(s, 'rssBytes', 'max')]
    run = dict(base, path=rel, startedAt=meta.get('startedAt'),
               endedAtUtc=__import__('datetime').datetime.utcfromtimestamp(last_t / 1000).strftime('%Y-%m-%dT%H:%M:%SZ') if last_t else None,
               durationMin=r((last_t - first_t) / 60000, 1) if last_t and first_t else None,
               serverCpus=','.join(map(str, srv_cpus)), harnessCpus=','.join(map(str, g(meta, 'placement', 'harnessCpus') or [])),
               bdsVersion=meta.get('bdsVersion') or cfg.get('bdsVersion'),
               artifacts='; '.join(f"{a.get('name')}={a.get('version')}" for a in (g(meta, 'server', 'artifacts') or [])),
               runtime=g(meta, 'server', 'spec', 'runtime'), harnessGit=(g(meta, 'harness', 'git') or '')[:12],
               cpuModel=g(meta, 'host', 'cpuModel'), machineFingerprint=g(meta, 'machine', 'fingerprint'), placementLabel=g(meta, 'placement', 'label'),
               placementMode=g(meta, 'placement', 'mode'), placementIssues=placement_issues, config=cfg.get('name'),
               botsPerWorker=lg.get('botsPerWorker'), joinIntervalMs=lg.get('joinIntervalMs'), connectRetries=lg.get('connectRetries'),
               lagThresholdMs=(lg.get('saturation') or {}).get('eventLoopP99Ms'), satMaxFrac=(cfg.get('gates') or {}).get('loadgenSaturatedMaxFraction'),
               rampStart=rp.get('start'), rampStep=rp.get('step'), settleSec=rp.get('settleSec'), holdSec=rp.get('holdSec'),
               minAvgTps=(cfg.get('criteria') or {}).get('minAvgTps'), warmupSec=cfg.get('warmupSec'), repeatsCfg=cfg.get('repeats'),
               method='final' if not early else 'early: ' + '; '.join(early),
               hasResult=res is not None, maxPlayers='/'.join(map(str, (res or {}).get('maxPlayers') or [])), maxPlayersMax=mx,
               maxPlayersMedian=(res or {}).get('maxPlayersMedian'), repeatStatus='/'.join(x.get('status') or '' for x in reps),
               statusReasons=' | '.join('; '.join(x.get('statusReasons') or []) for x in reps if x.get('statusReasons')),
               capped=(res or {}).get('capped'), loadgenLimited=(res or {}).get('loadgenLimited'), invalidLimited=(res or {}).get('invalidLimited'),
               steps=len(steps), invalidSteps=len(steps) - len(valid_steps), stepsSource=steps_src,
               firstFailPlayers=ff.get('players') if ff else None, firstFailReasons='; '.join(ff.get('failReasons') or []) if ff else None,
               rssPeakMiB=r(max(rss_all) / 2**20, 1) if rss_all else None,
               capTps=r(g(cap, 'tps', 'mean')), capCounterTps=r((cap or {}).get('counterTps')), capMainUtil=r(g(cap, 'mainThreadUtil', 'mean'), 4),
               capServerCores=r((g(cap, 'cpuPct', 'mean') or 0) / 100) if cap else None, capTickCpuMs=r((cap or {}).get('tickCpuMsPerTick')),
               capTickMsP99=r(g(cap, 'tickIntervalMs', 'p99')), capRttMsP50=r(g(cap, 'rttMs', 'p50'), 2), capRssMiB=r((g(cap, 'rssBytes', 'max') or 0) / 2**20, 1) if cap else None,
               failTps=r(g(ff, 'tps', 'mean')) if ff else None, failMainUtil=r(g(ff, 'mainThreadUtil', 'mean'), 4) if ff else None,
               bdsEvents='; '.join(bds_events), events=sum(kinds.values()))
    return run, step_rows, ts_rows(bins10, 10), ts_rows(bins60, 60), thread_rows


def write_csv(path, rows, cols=None):
    cols = cols or list(dict.fromkeys(k for row in rows for k in row))
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'wt', newline='', encoding='utf8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore'); w.writeheader(); w.writerows(rows)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    dirs = sorted(os.path.dirname(p) for p in glob.glob(os.path.join(ROOT, '**', 'samples.jsonl'), recursive=True))
    with Pool(min(16, os.cpu_count() or 4)) as pool:
        results = pool.map(process, dirs, chunksize=1)
    runs = [x[0] for x in results]
    in_report = set()
    if REPORT_RUNS:
        for row in json.load(open(REPORT_RUNS))['rows']: in_report.add((REPORT_HOST[row['machine']], row['runDir']))
    for x in runs: x['inReport'] = (x['host'], x['runId']) in in_report
    key = lambda x: (x['category'] != 'sweep', x['category'], x['vcpu'] or 0, x['server'] or '', x['rep'] or 0, x['runId'])
    runs.sort(key=key)
    order = {(x['host'], x['runId']): i for i, x in enumerate(runs)}
    srt = lambda rows: sorted(rows, key=lambda z: order[(z['host'], z['runId'])])
    write_csv(os.path.join(OUT, 'runs.csv'), runs)
    write_csv(os.path.join(OUT, 'steps.csv'), srt([s for x in results for s in x[1]]), STEP_COLS)
    ts10 = defaultdict(list)
    for s in srt([s for x in results for s in x[2]]): ts10[s['host']].append(s)
    os.makedirs(os.path.join(OUT, 'timeseries_10s'), exist_ok=True)
    for h, rows in ts10.items(): write_csv(os.path.join(OUT, 'timeseries_10s', h + '.csv'), rows, TS_COLS)
    write_csv(os.path.join(OUT, 'timeseries_60s.csv'), srt([s for x in results for s in x[3]]), TS_COLS)
    write_csv(os.path.join(OUT, 'thread_cpu_by_step.csv'), srt([s for x in results for s in x[4]]))

    # capacity summary over the report's valid sweep runs (category sweep, not invalid-limited, repeat ok)
    grp = defaultdict(list)
    for x in runs:
        if x['category'] == 'sweep' and x['hasResult'] and not x['invalidLimited'] and 'ok' in (x['repeatStatus'] or ''):
            grp[(x['vcpu'], x['server'])].append(x)
    summ = []
    for (n, s), xs in sorted(grp.items()):
        xs.sort(key=lambda z: z['rep']); v = [z['maxPlayersMax'] for z in xs]
        summ.append({'vcpu': n, 'server': s, 'runs': len(xs), 'maxBotsByRep': '/'.join(map(str, v)), 'median': S.median(v), 'min': min(v), 'max': max(v),
                     'mean': r(S.mean(v), 1), 'rssPeakMiBMax': max(z['rssPeakMiB'] or 0 for z in xs),
                     'capMainUtilMedian': r(S.median([z['capMainUtil'] for z in xs if z['capMainUtil'] is not None]), 4) if any(z['capMainUtil'] is not None for z in xs) else None,
                     'capServerCoresMedian': r(S.median([z['capServerCores'] for z in xs if z['capServerCores'] is not None])) if any(z['capServerCores'] is not None for z in xs) else None,
                     'earlyMethodRuns': sum(1 for z in xs if z['method'] != 'final')})
    write_csv(os.path.join(OUT, 'capacity_summary.csv'), summ)
    print(len(runs), 'runs;', sum(len(x[1]) for x in results), 'steps;', sum(len(x[2]) for x in results), '10s bins;',
          sum(len(x[3]) for x in results), '60s bins;', sum(len(x[4]) for x in results), 'thread rows;', len(summ), 'capacity cells')
