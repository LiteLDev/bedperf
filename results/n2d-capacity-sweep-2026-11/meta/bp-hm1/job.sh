#!/bin/bash
# job.sh <id> <N> <flavor> <rep> <cpus> <port> <agent host:port> <server overlay ip> [cfg set, default sweep] [harness cpus, default = server cpus]
# Runs inside a transient systemd unit (AllowedCPUs = <cpus>, MemoryMax = 8N GiB). Own cache dir with its own
# copy of the Wine server dir (own WINEPREFIX, so its own wineserver); everything else symlinked to the shared cache.
id=$1 N=$2 F=$3 R=$4 CPUS=$5 PORT=$6 AG=$7 SELF=$8 CS=${9:-sweep} HCPUS=${10:-$5}
. ~/bpx/env.sh
export BEDPERF_AGENT_TOKEN=$(cat $EXP/.token)
S=$(readlink -f ~/.cache/bedperf)
JR=$( [ -d /ephemeral/jobs ] && echo /ephemeral/jobs || echo $EXP/jobs ); J=$JR/$id
rm -rf $J; mkdir -p $J/cache/servers $J/tmp $EXP/jobstate
for e in $S/*; do [ "$(basename $e)" = servers ] || ln -s $e $J/cache/; done
for d in $S/servers/*; do
  b=$(basename $d)
  if [[ "$b" =~ ^${F}-[0-9a-f]{12}$ ]] && [[ "$F" == *-wine ]]; then
    cp -a $d $J/cache/servers/
    python3 - $J/cache/servers/$b <<'PY'
import json, sys
root = sys.argv[1]; p = root + '/.bedperf-complete.json'
m = json.load(open(p)); m['wine']['prefix'] = root + '/server/.lip/wine'
json.dump(m, open(p, 'w'), indent=2)
PY
  else ln -s $d $J/cache/servers/; fi
done
export BEDPERF_CACHE_DIR=$J/cache TMPDIR=$J/tmp
cat > $J/profile.json <<X
{"label":"n2d-highmem-224 job $id ($N vCPU)","placement":{"serverCpus":"$CPUS","botCpus":"auto","harnessCpus":"$HCPUS","priority":"normal"}}
X
OUT=$EXP/runs/$CS/N$N/$F/r$R; mkdir -p $OUT
echo "$(date -u +%FT%TZ) start $id cpus=$CPUS harness=$HCPUS port=$PORT agent=$AG host=$(hostname)" >> $OUT/jobs.log
node $EXP/src/packages/cli/src/main.ts run --config $EXP/cfg/$CS/$F.json --machine-profile $J/profile.json \
  --agents $AG --bot-target-host $SELF --port $PORT --runs-dir $OUT --no-lock --skip-idle-check \
  --set gates.foreignMean=100000 --set gates.foreignPeak10s=100000 --accept-eula > $J/console.log 2>&1
rc=$?
cp $J/console.log $OUT/console-$id.log
echo "$(date -u +%FT%TZ) end $id rc=$rc" >> $OUT/jobs.log
WS=$(find ~/.local/share/lip/wine -maxdepth 4 -path "*bin/wineserver" -type f | head -1)
for pf in $J/cache/servers/*/server/.lip/wine; do [ -d "$pf" ] && [ ! -L "$(dirname $(dirname $(dirname $pf)))" ] && WINEPREFIX=$pf $WS -k 2>/dev/null; done
rm -rf $J
echo $rc > $EXP/jobstate/$id.rc
exit $rc
