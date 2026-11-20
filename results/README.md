# Results

Benchmark results kept in the repository as plain text (CSV, JSON, JSON Lines, logs, scripts). Host names, cloud
account names, internal addresses and home paths are scrubbed; each data set's README lists what was replaced.
Generated HTML reports with embedded binary data are not committed; each data set says how to rebuild its report.

| Directory | What |
|---|---|
| [n2d-capacity-sweep-2026-11](n2d-capacity-sweep-2026-11/README.md) | Capacity sweep on three GCE n2d-standard-224 machines: 5 server implementations (BDS, BDS under Wine, Endstone, LeviLamina and LeviLamina + LeviOptimize under Wine) × 1–32 vCPU × 3 repeats, plus voided and early attempts. Per-run, per-step, time-series and per-thread tables; the configs, scheduler state and logs; and the published report's data. |
| [local-quick-walk-20261116](local-quick-walk-20261116/) | The first end-to-end `bedperf run` (preset `quick-walk`, BDS 1.26.63.1, Windows, bots on the same machine): raw run files. Rebuild its HTML report with `corepack pnpm bedperf report results/local-quick-walk-20261116/20261116-201726-quick-walk`. |
