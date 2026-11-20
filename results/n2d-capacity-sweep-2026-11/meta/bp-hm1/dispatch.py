#!/usr/bin/env python3
"""Job dispatcher for the packed sweep on identical machines that run both servers and bots.

Jobs: (N vCPU, flavor, rep) for N in 1..32, 5 flavors, 3 reps. A job's server runs `job.sh` in a transient systemd
unit on some machine with AllowedCPUs = its own CPUs (whole SMT cores in one NUMA node for N >= 2, one thread for
N = 1) and MemoryMax = 8N GiB. Its bots run on an agent from the pool of some machine (possibly another one).

Bots: on every machine all CPUs not given to a server form bp-bots.slice (the agents and their workers live there);
the dispatcher shrinks the slice before starting a server and grows it after one ends.

Admission: a job's bot count grows by 2 every 3 min until its peak (bots at 15 TPS, estimated per N and learned
from finished jobs), when the job ends. A job is admitted only if, for every future time, the projected bot CPU of
the jobs on its bot machine fits in BOT_BUDGET of that machine's bot pool.

State in dispatch-state.json (resumable). Usage: dispatch.py <config.json>
"""
import json, os, subprocess, sys, time, random

CFG = json.load(open(sys.argv[1]))
STATE = os.path.expanduser(CFG.get('state', '~/bpx/dispatch-state.json'))
LOG = os.path.expanduser(CFG.get('log', '~/bpx/logs/dispatch.log'))
NS = CFG.get('ns', [32, 16, 8, 4, 2, 1])
FLAVORS = CFG.get('flavors', ['bds', 'endstone', 'bds-wine', 'levilamina-wine', 'levilamina-levioptimize-wine'])
REPS = CFG.get('reps', 3)
MAX_ATTEMPTS = CFG.get('maxAttempts', 3)
CORE_PER_BOT = CFG.get('corePerBot', 0.08)
# per-bot cost grows with the player count (every bot receives every other player's updates):
# cores(n) = n * (CORE_PER_BOT + CORE_PER_BOT2 * n)
CORE_PER_BOT2 = CFG.get('corePerBot2', 0.0)
BOT_CORE_BASE = CFG.get('botCoreBase', 0.0)
BOT_CORE_CAP = CFG.get('botCoreCap', 1e9)  # measured: a job's bots never used more than ~44 cores
BOT_BUDGET = CFG.get('botBudget', 0.8)
PEAK0 = {int(k): v for k, v in CFG.get('peakGuess', {'1': 80, '2': 100, '4': 150, '8': 220, '16': 250, '32': 260}).items()}
STEP_MIN = CFG.get('stepMin', 3.0)     # minutes per step
STEP_BOTS = CFG.get('stepBots', 2)
WARM_MIN = CFG.get('warmMin', 5.0)     # install/warmup before the first step
POLL = CFG.get('pollSec', 30)
LAUNCH_GAP = CFG.get('launchGapSec', 15)
AGENT_PORTS = CFG.get('agentPorts', [20000, 20063])
HARNESS_CORES = CFG.get('harnessCoresPerNode', 2)  # reserved per NUMA node for the measuring processes
BUSY_MAX = CFG.get('busyMax', 0.7)  # a machine above this measured CPU busy fraction takes no new bots
ONLY = CFG.get('only')  # optional list of job ids (smoke)
CS = CFG.get('cfg', 'sweep')  # config set under ~/bpx/cfg and runs dir under ~/bpx/runs


def log(msg):
    line = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' ' + msg
    print(line, flush=True)
    with open(LOG, 'a') as f:
        f.write(line + '\n')


def ssh(ip, cmd, timeout=90):
    try:
        r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', ip, cmd],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return 124, 'timeout'


def topology(ip):
    """(all cpus, [(node, (cpuA, cpuB))] physical cores for servers, {'all': [harness cpus]}).
    One harness pool per machine: the 2*HARNESS_CORES highest cores whose threads are all >= 64. Wine sets some
    LeviLamina threads' affinity to Windows processor group 0 = host CPUs 0-63; inside a job's cgroup (server CPUs +
    harness CPUs) that must never reach a harness CPU, so harness CPUs are >= 64. CPU 0/1's cores are never server
    cores (system noise); they stay in the bot pool."""
    rc, out = ssh(ip, 'for c in /sys/devices/system/cpu/cpu[0-9]*; do n=$(basename $c); '
                      'echo "${n#cpu} $(cat $c/topology/thread_siblings_list) $(ls -d $c/node* | head -1 | sed s/.*node//)"; done')
    cores, allc = {}, []
    for line in out.strip().splitlines():
        cpu, sib, node = line.split()
        allc.append(int(cpu))
        sibs = tuple(sorted(int(x) for x in sib.replace('-', ',').split(',')))
        cores[sibs] = int(node)
    allcores = sorted(((n, s) for s, n in cores.items()), key=lambda x: x[1], reverse=True)
    hcores = [c for c in allcores if min(c[1]) >= 64][:2 * HARNESS_CORES]
    if len(hcores) < 2 * HARNESS_CORES:  # small machine (bots only): any highest cores
        hcores = allcores[:2 * HARNESS_CORES]
    harness = sorted(x for _, s in hcores for x in s)
    usable = sorted(c for c in allcores if c not in hcores and 0 not in c[1] and 1 not in c[1])
    return sorted(allc), usable, {'all': harness}


def cpulist(cpus):
    return ','.join(map(str, sorted(cpus)))


def new_state():
    jobs = []
    for n in NS:
        for r in range(1, REPS + 1):
            fl = FLAVORS[:]
            random.Random(n * 100 + r).shuffle(fl)
            for f in fl:
                jobs.append({'id': f'N{n}-{f}-r{r}', 'n': n, 'flavor': f, 'rep': r, 'status': 'pending', 'attempts': 0})
    if ONLY:
        jobs = [j for j in jobs if j['id'] in ONLY]
    return {'jobs': jobs, 'peaks': {}}


def main():
    st = json.load(open(STATE)) if os.path.exists(STATE) else new_state()
    machines = CFG['machines']  # [{name, ip}]
    M = {m['name']: m for m in machines}
    topo = {}
    for m in machines:
        topo[m['name']] = topology(m['ip'])
        log(f"{m['name']}: {len(topo[m['name']][0])} cpus, {len(topo[m['name']][1])} server/bot cores, "
            f"harness cpus {topo[m['name']][2]}")

    def peak(n, flavor=None):
        # learned peak of this (N, flavor) if any, else of this N (max over flavors), else the initial guess
        if flavor is not None and st.get('peaksF', {}).get(f'{n}-{flavor}'):
            return st['peaksF'][f'{n}-{flavor}']
        return st['peaks'].get(str(n)) or PEAK0.get(n, 200)

    def running():
        return [j for j in st['jobs'] if j['status'] == 'running']

    def server_cpus(name):
        s = set()
        for j in running():
            if j['machine'] == name:
                s.update(j['cpus'])
        return s

    def harness_all(name):
        if M[name].get('botsOnly'):
            return set()
        return {c for v in topo[name][2].values() for c in v}

    def harness_for(name, cpus):
        return topo[name][2]['all']

    def bot_pool(name, extra=()):
        return len(topo[name][0]) - len(harness_all(name)) - len(server_cpus(name)) - len(extra)

    def set_slice(name):
        pool = sorted(set(topo[name][0]) - server_cpus(name) - harness_all(name))
        rc, out = ssh(M[name]['ip'], f'sudo systemctl set-property --runtime bp-bots.slice AllowedCPUs={cpulist(pool)}')
        if rc != 0:
            log(f'{name}: set bots slice failed: {out.strip()}')
        return rc == 0

    def bots_at(j, t):
        """Projected bot count of job j at absolute time t (0 after it would have reached its peak)."""
        p = peak(j['n'], j.get('flavor'))
        el = (t - j['start']) / 60 - WARM_MIN
        if el < 0:
            return STEP_BOTS
        b = STEP_BOTS * (1 + int(el / STEP_MIN))
        return 0 if b > p + 2 * STEP_BOTS else min(b, p)

    def cores(n):
        # bot CPU of one job with n bots: rises ~linearly, plateaus (and falls once the server falls behind and sends less)
        if n <= 0:
            return 0
        return min(n * (CORE_PER_BOT + CORE_PER_BOT2 * n) + BOT_CORE_BASE, BOT_CORE_CAP)

    def fits(botm, newjob, server_extra):
        now = time.time()
        jobs = [j for j in running() if j['botMachine'] == botm] + [newjob]
        horizon = max(STEP_MIN * (peak(j['n'], j.get('flavor')) / STEP_BOTS) + WARM_MIN for j in jobs) * 60
        cap = BOT_BUDGET * bot_pool(botm, server_extra)
        for k in range(0, int(horizon / 300) + 2):
            t = now + k * 300
            if bots_at(newjob, t) > 0 and sum(cores(bots_at(j, t)) for j in jobs) > cap:
                return False
        return True

    def alloc(name, n, flavor=''):
        if M[name].get('botsOnly'):
            return None
        busy = server_cpus(name)
        cores = topo[name][1]
        if 'wine' in flavor and n >= 2:
            # Wine sets some threads' affinity to Windows processor group 0 = host CPUs 0-63. On a core with a thread
            # below 64 that silently confines the server to those threads; on cores whose threads are all >= 64 the
            # request fails and the threads keep the job's CPUs.
            cores = [c for c in cores if min(c[1]) >= 64]
        if n == 1:
            half = [c for _, c in cores if len([x for x in c if x in busy]) == 1]
            free = [c for _, c in cores if not any(x in busy for x in c)]
            for c in half + free:
                for x in c:
                    if x not in busy:
                        return [x]
            return None
        need = n // 2
        best = None
        for node in sorted(set(nd for nd, _ in cores)):
            free = [c for nd, c in cores if nd == node and not any(x in busy for x in c)]
            if len(free) >= need and (best is None or len(free) < best[0]):
                best = (len(free), free[:need])
        return None if best is None else sorted(x for c in best[1] for x in c)

    for m in machines:
        set_slice(m['name'])
    last_launch = 0
    while True:
        # 1. reap
        for m in machines:
            name = m['name']
            rc, out = ssh(m['ip'], 'for f in ~/bpx/jobstate/*.rc; do [ -f "$f" ] && echo "$(basename $f .rc) $(cat $f)"; done; '
                                   "echo ---; systemctl list-units 'bpj-*' --plain --no-legend --all | awk '{print $1}'")
            if rc != 0 or '---' not in out:
                log(f'{name}: poll failed ({rc}) {out.strip()[:200]}'); continue
            done_part, units_part = out.split('---', 1)
            rcs = dict(l.split()[:2] for l in done_part.strip().splitlines() if len(l.split()) >= 2)
            units = {l.strip()[4:].removesuffix('.service') for l in units_part.strip().splitlines() if l.strip()}
            changed = False
            for j in running():
                if j['machine'] != name:
                    continue
                uid = j['unit']
                if uid not in rcs and uid in units:
                    continue
                if uid in rcs:
                    j['rc'] = int(rcs[uid])
                    ssh(m['ip'], f'rm -f ~/bpx/jobstate/{uid}.rc')
                else:
                    j['rc'] = None
                j['end'] = time.time(); changed = True
                if j['rc'] == 0:
                    j['status'] = 'done'
                    _, res = ssh(m['ip'], f"python3 -c \"import json,glob; r=[json.load(open(p)) for p in sorted(glob.glob('$HOME/bpx/runs/{CS}/N{j['n']}/{j['flavor']}/r{j['rep']}/**/result.json', recursive=True))]; print(json.dumps([r[-1].get('maxPlayers'), r[-1].get('invalidLimited') or not (r[-1].get('capped') or any(('TPS' in x or 'tps' in x) for s in [st for st in json.load(open(sorted(glob.glob('$HOME/bpx/runs/{CS}/N{j['n']}/{j['flavor']}/r{j['rep']}/2*/steps.json'))[-1])) if not st.get('invalidReasons')][-1:] for x in (s.get('failReasons') or [])))]))\"")
                    try:
                        mpl, invl = json.loads(res.strip().splitlines()[-1])
                        mp = max(mpl or [0])
                        j['maxPlayers'] = mp
                        if invl:
                            # stopped on two invalid steps in a row, or the last step failed for a reason other than TPS:
                            # a lower bound, not the 15 TPS point -> retry
                            j['status'] = 'pending' if j['attempts'] < MAX_ATTEMPTS else 'failed'
                            j['invalidLimited'] = True
                            ssh(m['ip'], f"mkdir -p ~/bpx/old/invalid/{uid} && mv ~/bpx/runs/{CS}/N{j['n']}/{j['flavor']}/r{j['rep']}/2* ~/bpx/old/invalid/{uid}/")
                        else:
                            st['peaks'][str(j['n'])] = max(st['peaks'].get(str(j['n']), 0), mp + 4)
                            kf = f"{j['n']}-{j['flavor']}"; st.setdefault('peaksF', {})[kf] = max(st['peaksF'].get(kf, 0), mp + 4)
                    except Exception as ex:
                        log(f'{uid}: cannot read result ({ex}): {res.strip()[:200]}')
                else:
                    j['status'] = 'pending' if j['attempts'] < MAX_ATTEMPTS else 'failed'
                    ssh(m['ip'], f"mkdir -p ~/bpx/old/invalid/{uid} && mv ~/bpx/runs/{CS}/N{j['n']}/{j['flavor']}/r{j['rep']}/2* ~/bpx/old/invalid/{uid}/ 2>/dev/null; true")
                log(f"{uid} finished rc={j['rc']} after {(j['end'] - j['start']) / 3600:.2f} h -> {j['status']} max={j.get('maxPlayers')}")
            if changed:
                set_slice(name)
        json.dump(st, open(STATE + '.tmp', 'w'), indent=1); os.replace(STATE + '.tmp', STATE)

        pend = [j for j in st['jobs'] if j['status'] == 'pending']
        if not pend and not running():
            log('ALL DONE'); break

        # 2. admit at most one job per gap: largest first; smaller jobs may fill gaps the large ones cannot use
        if pend and time.time() - last_launch >= LAUNCH_GAP:
            used_agents = {j['agent'] for j in running()}
            busy = {}
            for mm in machines:
                rc_, o_ = ssh(mm['ip'], "a=($(head -1 /proc/stat)); sleep 3; b=($(head -1 /proc/stat)); i=$(( (b[4]+b[5])-(a[4]+a[5]) )); t=0; for k in 1 2 3 4 5 6 7 8; do t=$((t+b[k]-a[k])); done; echo $(( (t-i)*1000/t ))")
                try: busy[mm['name']] = int(o_.strip().split()[-1]) / 1000
                except Exception: busy[mm['name']] = 1.0
            for j in pend:
                placed = None
                for m in sorted(machines, key=lambda m: -len(server_cpus(m['name']))):
                    a = alloc(m['name'], j['n'], j['flavor'])
                    if a is None:
                        continue
                    # bot machine: most headroom, counting this server's cpus if it is the same machine
                    cands = sorted(machines, key=lambda b: -(bot_pool(b['name'], a if b['name'] == m['name'] else ())))
                    for b in cands:
                        if busy.get(b['name'], 1.0) > BUSY_MAX:
                            continue
                        probe = {'n': j['n'], 'flavor': j['flavor'], 'start': time.time()}
                        if fits(b['name'], probe, a if b['name'] == m['name'] else ()):
                            placed = (m, a, b); break
                    if placed:
                        break
                if placed is None:
                    continue
                m, a, b = placed
                # round-robin from a cursor: a just-freed agent is not reused soon (its upgrade timer gets there first)
                nag = b.get('agents', 64); cur = st.setdefault('agentCursor', {}).get(b['name'], 0)
                ports = [AGENT_PORTS[0] + (cur + k) % nag for k in range(nag)]
                agent = next((f"{b['ip']}:{p}" for p in ports if f"{b['ip']}:{p}" not in used_agents), None)
                if agent is not None:
                    st['agentCursor'][b['name']] = (int(agent.rsplit(':', 1)[1]) - AGENT_PORTS[0] + 1) % nag
                if agent is None:
                    continue
                ports = {jj['port'] for jj in running() if jj['machine'] == m['name']}
                port = next(p for p in range(30000, 40000, 2) if p not in ports)
                j['attempts'] += 1
                uid = f"{j['id']}-a{j['attempts']}"
                j.update({'status': 'running', 'unit': uid, 'machine': m['name'], 'cpus': a, 'botMachine': b['name'],
                          'agent': agent, 'port': port, 'start': time.time()})
                if not set_slice(m['name']):
                    j['status'] = 'pending'; j['attempts'] -= 1; break
                h = harness_for(m['name'], a)
                j['harnessCpus'] = h
                cmd = (f"sudo systemd-run --collect --unit=bpj-{uid} --uid=$(id -u) --gid=$(id -g) "
                       f"-p AllowedCPUs={cpulist(list(a) + h)} -p MemoryMax={8 * j['n']}G -p MemorySwapMax=0 -p CPUAccounting=yes -p MemoryAccounting=yes "
                       f"--setenv=HOME=$HOME bash $HOME/bpx/job.sh {uid} {j['n']} {j['flavor']} {j['rep']} {cpulist(a)} {port} {agent} {m['ip']} {CS} {cpulist(h)}")
                rc, out = ssh(m['ip'], cmd)
                if rc != 0:
                    log(f"launch {uid} on {m['name']} failed: {out.strip()}")
                    j['status'] = 'pending'; j['attempts'] -= 1; set_slice(m['name']); break
                log(f"start {uid} server {m['name']} cpus={cpulist(a)} harness={cpulist(h)} bots {b['name']} agent={agent} port={port} "
                    f"(bot pool {b['name']}: {bot_pool(b['name'])} cpus)")
                last_launch = time.time()
                json.dump(st, open(STATE + '.tmp', 'w'), indent=1); os.replace(STATE + '.tmp', STATE)
                break
        time.sleep(POLL)


if __name__ == '__main__':
    main()
