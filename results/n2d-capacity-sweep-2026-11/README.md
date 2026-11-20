# bedperf n2d 服务端容量扫描：数据集

整理时间：2026-11-20。实验时间：2026-11-17 至 2026-11-20。

## 机器

3 台 GCE n2d-standard-224（AMD EPYC 7B13，2 个 NUMA 节点，224 vCPU），Ubuntu 22.04，下文称 `hm1`、`z1`、`z2`（目录名 `bp-hm1`、`bp-z1`、`bp-z2`）。另有 11-17 在第一套 n2d 机器（32 核服务端加 bot 机）上跑的早期测试，目录名 `old-n2d`。

## 脱敏说明

本目录已发布到公开仓库，相对原始数据做了以下替换，其余内容未改动：

- 机器标签去掉了云账号/组织名，只保留 `hm1`、`z1`、`z2`。
- 云实例主机名换成 `hm1-host`、`z1-host`、`z2-host`、`highmem-srv`（文件名同步改名）。
- 内网地址 `10.x.0.N` 统一换成 `10.0.0.N`，末位保持不变，所以机器之间的对应关系仍然成立。
- `/home/<user>` 换成 `~`。
- `meta/machines/pk-*.txt`（dpkg 包列表）删掉了 GPU 驱动相关的包，这些包和本实验无关。

## 运行分类

每个含 `samples.jsonl` 的目录算一次 bedperf 运行，一共 160 次。

| category | 次数 | 说明 |
|---|---|---|
| `sweep` | 90 | 正式结果：5 种服务端 × 6 档 vCPU × 3 次重复，也就是报告用的数据 |
| `old/invalid` | 24 | 作废：20 次是 invalid-limited（容量受作废 step 限制），3 次是 agent 掉线，1 次是 N32 LeviLamina (Wine) 的 `notps` 尝试（目录名标为 notps，result 本身是 ok） |
| `old/wine-affinity` | 10 | Wine 线程亲和性问题：分到 <64 号核时只能用一半 vCPU。已作废重跑 |
| `old/stopped-old-config` | 6 | 改配置时中途停掉，没有 result.json |
| `old/sweep-try1-0144` | 8 | 11-18 01:44 第一次启动 sweep，很快就停了 |
| `old-n2d/full` | 16 | 11-17 core-scan：每次 3 个重复，判定标准是 minAvgTps 19.8，和正式 sweep 不同 |
| `old-n2d/smoke`、`old-n2d/sweep-smoke` | 6 | 冒烟测试 |

## 文件

全部是纯文本（CSV、JSON、日志、脚本），没有压缩包和二进制。

| 文件 | 行数 | 粒度 |
|---|---|---|
| `capacity_summary.csv` | 30 | vCPU × 服务端：3 次重复的 bot 数、中位数、最小值、最大值、内存峰值，以及容量点的主线程占用和服务端核数 |
| `runs.csv` | 160 | 每次运行一行（所有 category）：配置、版本、CPU 绑定、方法参数、结果、首次失败的 step、容量点指标、是否在报告中 |
| `steps.csv` | 5,769 | 每个负载台阶一行：TPS、tick 间隔分位数、主线程占用、CPU、RSS、RTT、gametime 延迟、区块、网络、干扰、失败或作废原因 |
| `timeseries_10s/<host>.csv` | 111,223 | 10 秒一格的时序，按 `host` 拆成 4 个文件（列相同）：bot 数、TPS、tick p99、服务端核数、主线程、RSS/private、线程数、网络、bot 端核数/RSS/事件循环延迟/饱和比例、主机和 agent 的繁忙核数与外来负载 |
| `timeseries_60s.csv` | 18,622 | 字段同上，1 分钟一格。和报告里的分钟曲线同一种切法 |
| `thread_cpu_by_step.csv` | 25,860 | 每个 step 的测量窗口内，各线程名的平均 CPU%（单位：一个核的百分比） |
| `dispatch_jobs.csv` | 90 | 调度器的最终状态：尝试次数、最终 unit、服务端和 bot 所在机器、agent、CPU 列表、起止时间、rc |
| `attempts.csv` | 262 | 所有 `jobs.log` 的 start/end 行，包括作废的尝试 |
| `meta/<host>/` | — | `cfg/`（各服务端配置和 vCPU profile）、`logs/`（调度、agent、安装日志）、`sweep-cfg.json`、`sweep-state.json`；hm1 另有 `dispatch.py`、`gen3.py`、`job.sh` 和旧调度状态 |
| `meta/machines/` | — | 两类机器的 dpkg 包列表和 sysctl，`res-*.json`（11-19 08:00 的中间汇总），sweep 和 smoke 的调度配置 |
| `report-snapshot/` | — | 已发布报告的 `runs.json`、`curves.json`、`index.html` 和生成它们的两个脚本 |
| `scripts/` | — | 生成本目录 CSV 的脚本，以及交互报告的模板和打包脚本 |

### 关键字段

- 运行标识：`host` + `runId` 唯一。`vcpu` 是服务端绑定的 CPU 数（`serverCpus` 的长度），`rep` 是第几次重复，`attempt` 是第几次尝试。
- `method`：`final` 是最终方法；`early: …` 列出和最终方法不同的设置（没有 15 秒等待、每个 worker 放 2 个 bot、bot 端延迟阈值 50 ms、任何一秒饱和就判作废）。
- 容量：`maxPlayersMax` 是该次运行的容量。`cap*` 是容量点那个 step 的指标，`firstFail*` 是第一个未通过的有效 step。
- `steps.csv` 的 `tpsMean` 是 probe 采样 TPS 的均值，`counterTps` 是 tick 计数算出的 TPS。`mainUtil*` 是 tick 线程占用（0–1），`serverCpuPct*` 是整个进程的 CPU%（100 = 1 核）。
- 时序表的 `tSec` 从每个重复的 `orch.repeat.start` 开始算。`stepState` 取值 `warmup`、`settle`、`measure`、`gap`，表示这一格开始时所处的阶段。`srvSetForeignCores` 是服务端 CPU 集合上的外来负载。
- `thread_cpu_by_step`：`sys.sample` 每秒只记 CPU 最高的 5 个线程。同名线程先在每次采样内相加，再在 step 窗口里取平均，没进前 5 的那次采样按 0 算。

## 结论（容量中位数）

`capacity_summary.csv` 的中位数和报告结论一致：原生 BDS 在 1、2、4、8、16、32 vCPU 下是 78、96、106、110、110、112；Endstone 在 8 vCPU 是 122，32 vCPU 是 126。

## 核对

- 报告里的 90 次运行都能在 `runs.csv` 中找到（`inReport=True`）。逐条比较了 bot 数、vCPU、服务端、重复次序、方法版本、作废 step 数，全部一致；内存峰值最多差 0.01 GiB，是舍入造成的。
- 抽查了 `timeseries_60s.csv` 中 4 vCPU BDS 第 2 次的分钟数据，bot 数、TPS、RSS、主线程占用都和报告的 `curves.json` 相同。

## 不在这里的东西

- 实验没有采集过 perf、火焰图、eBPF 这类 profiling。线程级数据只有 `sys.sample` 里每秒前 5 个线程的 CPU%，已经整理进 `thread_cpu_by_step.csv`。
- 每次运行的原始文件（`samples.jsonl`、`bds.log`、`console-*.log`、`report.html`）解压后约 5 GB，没有放进仓库，只保留在实验者本地的备份包里。世界存档、服务端二进制、系统日志也不在备份中。
- hm2：有 2 个正式任务的 bot 跑在 hm2（`10.0.0.12`）上（见 `dispatch_jobs.csv` 的 `botMachine`）。hm2 本机的 agent 日志没有备份。这些运行里 bot 端的遥测已经写进服务端的 `samples.jsonl`，不受影响。

## 重新生成

交互式离线报告（约 14 MB，数据以 gzip+base64 嵌入）不入库，需要时在本目录运行：

```bash
python scripts/pack_report.py
```

生成的 `report.html` 双击即可在浏览器打开。

从原始备份重建 CSV：把三个 `bp-*.tar.xz` 分别解到 `<root>/bp-hm1` 等目录，把 `old-runs.tgz` 解到 `<root>/old-n2d`，然后运行：

```bash
python scripts/build_dataset.py <root> . report-snapshot/runs.json
python scripts/build_dispatch.py <root> .
```
