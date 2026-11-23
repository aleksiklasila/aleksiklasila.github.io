#!/bin/sh
cd /z/data/gitrepos/aleksiklasila.github.io/rng/defence3
run() { name=$1; shift; start=$(date +%s); "$@" > tmp/mpt-$name.log 2>&1; code=$?; echo "$name exit=$code $(( $(date +%s) - start ))s $(grep -m1 -E '^(PASS|FAIL)|AssertionError|Error:' tmp/mpt-$name.log | cut -c1-200)"; }
run meta node tests/meta-structs-kernel.test.cjs
run rq-page node tests/research-queue.test.cjs
run rq-worker env SIM_WORKER=1 node tests/research-queue.test.cjs
run features-page node tests/multiplayer-features.test.cjs
run features-worker env SIM_WORKER=1 node tests/multiplayer-features.test.cjs
run concurrency-page node tests/multiplayer-concurrency.test.cjs
run concurrency-worker env SIM_WORKER=1 node tests/multiplayer-concurrency.test.cjs
run actionfuzz-page node tests/multiplayer-action-fuzz.test.cjs
run actionfuzz-worker env SIM_WORKER=1 node tests/multiplayer-action-fuzz.test.cjs
run scenarios-page node tests/multiplayer-scenarios.test.cjs
run scenarios-worker env SIM_WORKER=1 node tests/multiplayer-scenarios.test.cjs
run shrine-page node tests/shrine.test.cjs
run shrine-worker env SIM_WORKER=1 node tests/shrine.test.cjs
run rematch-page node tests/multiplayer-rematch.test.cjs
run rematch-worker env SIM_WORKER=1 node tests/multiplayer-rematch.test.cjs
run livejoin node tests/multiplayer-live-join-worker.test.cjs
run chaosdet-page node tests/multiplayer-chaos-determinism.test.cjs
run chaosdet-worker env SIM_WORKER=1 node tests/multiplayer-chaos-determinism.test.cjs
echo ALLDONE
