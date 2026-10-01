#!/bin/bash
# The three 1000-map benchmarks in turn (never run two benchmarks at once):
#   bash .claude/benchall.sh <outdir> <tag> [base|active|battle|towers|siege ...]
# towers: 8000 built towers per team (facing bands in range of each other);
# siege: those and the BATTLE=mix armies.
# Writes <outdir>/<tag>-<name>.json; prints p50/mean/max and the top phases.
cd "$(dirname "$0")/.."
OUT=${1:?outdir}; TAG=${2:-r}; shift 2
mkdir -p "$OUT"
run() {
  name=$1; shift
  env DATA=tests/100000-1000.json HELPERS=7 TOPPHASES=1 UPDSPLIT=1 KTIME=1 STATES=1 "$@" timeout 2400 node --max-old-space-size=12000 .claude/tickbench.cjs 5 > "$OUT/$TAG-$name.json" 2>&1
  node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const i=s.indexOf('{\"ticks\"');if(i<0){console.log(process.argv[2],'FAILED',s.slice(-500));process.exit(0)}const j=JSON.parse(s.slice(i));console.log(process.argv[2],'p50',j.p50,'mean',j.meanMs,'max',j.max,'upd',JSON.stringify(j.updSplit))" "$OUT/$TAG-$name.json" $name
  node .claude/phsum.cjs "$OUT/$TAG-$name.json" 100 | head -16
}
for w in ${@:-base active battle}; do
  case $w in
    base) run base ;;
    active) run active ACTIVE=1 ;;
    battle) run battle BATTLE=mix ;;
    towers) run towers TOWERS=8000 ;;
    siege) run siege TOWERS=8000 BATTLE=mix ;;
  esac
done
echo ALLDONE
