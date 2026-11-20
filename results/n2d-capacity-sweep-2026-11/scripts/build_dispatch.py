#!/usr/bin/env python3
"""dispatch_jobs.csv: final scheduler state of the 90 sweep jobs (sweep-state.json on each host; jobs show up on the host
that ran their server). attempts.csv: every start/end line of every jobs.log (all attempts incl. voided ones)."""
import csv, datetime, glob, json, os, re, sys
ROOT, OUT = sys.argv[1], sys.argv[2]
iso = lambda t: datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%dT%H:%M:%SZ') if t else None
rows = {}
for h in ('bp-hm1', 'bp-z1', 'bp-z2'):
    st = json.load(open(os.path.join(ROOT, h, 'sweep-state.json')))
    for j in st['jobs']:
        if j.get('status') == 'remote': continue          # this host's copy of a job run elsewhere
        rows[j['id']] = {'job': j['id'], 'vcpu': j.get('n'), 'flavor': j.get('flavor'), 'rep': j.get('rep'), 'status': j.get('status'),
                         'attempts': j.get('attempts'), 'finalUnit': j.get('unit'), 'serverHost': h, 'machine': j.get('machine'),
                         'botMachine': j.get('botMachine'), 'agent': j.get('agent'), 'port': j.get('port'),
                         'serverCpus': ','.join(map(str, j.get('cpus') or [])), 'harnessCpus': ','.join(map(str, j.get('harnessCpus') or [])),
                         'startUtc': iso(j.get('start')), 'endUtc': iso(j.get('end')),
                         'hours': round((j['end'] - j['start']) / 3600, 2) if j.get('end') and j.get('start') else None,
                         'rc': j.get('rc'), 'maxPlayers': j.get('maxPlayers'), 'invalidLimited': j.get('invalidLimited')}
rows = sorted(rows.values(), key=lambda r: (r['vcpu'], r['flavor'], r['rep']))
with open(os.path.join(OUT, 'dispatch_jobs.csv'), 'w', newline='', encoding='utf8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
att = []
for p in sorted(glob.glob(os.path.join(ROOT, '*', '**', 'jobs.log'), recursive=True)):
    rel = os.path.relpath(p, ROOT).replace(os.sep, '/')
    for line in open(p, encoding='utf8'):
        m = re.match(r'(\S+) (start|end) (\S+) ?(.*)', line.strip())
        if m: att.append({'host': rel.split('/')[0], 'jobsLog': rel, 'timeUtc': m[1], 'event': m[2], 'unit': m[3], 'detail': m[4]})
with open(os.path.join(OUT, 'attempts.csv'), 'w', newline='', encoding='utf8') as f:
    w = csv.DictWriter(f, fieldnames=list(att[0])); w.writeheader(); w.writerows(att)
print(len(rows), 'jobs;', len(att), 'jobs.log lines')
