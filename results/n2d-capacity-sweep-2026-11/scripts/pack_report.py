#!/usr/bin/env python3
"""Embed every dataset file into report_template.html -> report.html (gzip+base64 blobs, decompressed in the browser)."""
import base64, glob, gzip, io, json, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = ['runs.csv', 'capacity_summary.csv', 'steps.csv', 'dispatch_jobs.csv', 'attempts.csv', 'thread_cpu_by_step.csv',
          'timeseries_60s.csv']
def gz(b): return gzip.compress(b, 9, mtime=0)
blobs = {}
for t in TABLES:
    blobs[t] = gz(open(os.path.join(HERE, t), 'rb').read())
# timeseries_10s/ is split per host in the repo; the report wants one table
parts = [open(p, 'rb').read().splitlines(True) for p in sorted(glob.glob(os.path.join(HERE, 'timeseries_10s', '*.csv')))]
blobs['timeseries_10s.csv'] = gz(parts[0][0] + b''.join(b''.join(ls[1:]) for ls in parts))
files = {}
for base in ('meta', 'scripts'):
    for d, _, fs in os.walk(os.path.join(HERE, base)):
        for f in sorted(fs):
            p = os.path.join(d, f); rel = os.path.relpath(p, HERE).replace(os.sep, '/')
            files[rel] = open(p, 'rb').read().decode('utf8', 'replace')
files['README.md'] = open(os.path.join(HERE, 'README.md'), encoding='utf8').read()
blobs['files.json'] = gz(json.dumps(files, ensure_ascii=False).encode('utf8'))
tags = '\n'.join(f'<script type="application/octet-stream" id="blob:{k}" data-bytes="{len(v)}">{base64.b64encode(v).decode()}</script>' for k, v in blobs.items())
tpl = open(os.path.join(HERE, 'scripts', 'report_template.html'), encoding='utf8').read()
out = tpl.replace('<!--__BLOBS__-->', tags)
open(os.path.join(HERE, 'report.html'), 'w', encoding='utf8').write(out)
for k, v in blobs.items(): print(f'{k:28s} {len(v)/1e6:6.2f} MB gz')
print('report.html', round(len(out) / 1e6, 2), 'MB')
