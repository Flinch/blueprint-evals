#!/usr/bin/env bash
# Runs broken builds of the health bot, one at a time, each a number of times,
# and saves every suite to .evals/runs like a normal run. Spends real money on
# model calls, so it states the most it can spend and asks first.
#
# Usage (from the blueprint-evals folder):
#   examples/health-bot/run-defects.sh                 the four outright builds, 2 runs each
#   examples/health-bot/run-defects.sh 1               the four outright builds, 1 run each
#   examples/health-bot/run-defects.sh 2 leaks-schedule doses-medication
#
# The builds are listed in SPEC.md section 9. The bot listens on port 4021, as
# evals.defect.config.yaml expects, so nothing else may be using that port.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUNS="${1:-2}"
[ $# -gt 0 ] && shift
if [ $# -gt 0 ]; then BUILDS=("$@"); else BUILDS=(acts-without-asking doses-medication downplays-emergencies leaks-schedule); fi
if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then echo "The first argument is the number of runs per build, for example 2."; exit 2; fi

PORT=4021
CAP=0.08 # per scenario, in US dollars. The most any scenario has cost so far is about 0.04.
SCENARIOS=$(ls examples/health-bot/scenarios/*.yaml | wc -l | tr -d ' ')
SUITES=$((RUNS * ${#BUILDS[@]}))
WORST=$(awk "BEGIN { printf \"%.2f\", $SUITES * $SCENARIOS * $CAP }")

echo "Builds: ${BUILDS[*]}"
echo "$RUNS run(s) of each: $SUITES suites of $SCENARIOS scenarios."
echo "Capped at \$$CAP per scenario, so at most \$$WORST in total. Earlier suites cost about \$0.38 each."
read -r -p "Spend up to \$$WORST on real model calls? [y/N] " answer
if ! [[ "$answer" =~ ^[Yy]$ ]]; then echo "Nothing was run."; exit 0; fi

if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop whatever is on it first: kill \$(lsof -tiTCP:$PORT -sTCP:LISTEN)"
  exit 1
fi

bot=""
stop_bot() {
  if [ -n "$bot" ]; then kill "$bot" 2>/dev/null || true; wait "$bot" 2>/dev/null || true; fi
  bot=""
  # The bot runs in a child process, so make sure the port is free too.
  local left
  left=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$left" ]; then kill $left 2>/dev/null || true; fi
}
trap stop_bot EXIT

for build in "${BUILDS[@]}"; do
  log=".evals/bot-$build.log"
  echo
  echo "=== $build: starting the bot on port $PORT (log: $log)"
  PORT=$PORT npx tsx examples/health-bot/serve.ts --defect="$build" >"$log" 2>&1 &
  bot=$!
  for _ in $(seq 1 75); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
  if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "The bot did not start. See $log"
    exit 1
  fi
  for run in $(seq 1 "$RUNS"); do
    echo "=== $build: run $run of $RUNS"
    # A broken build is meant to fail scenarios, and the run exits non-zero when it does, so carry on.
    npm run --silent evals -- run examples/health-bot/scenarios --config examples/health-bot/evals.defect.config.yaml --max-cost "$CAP" --yes ||
      echo "=== $build: run $run finished with failing scenarios (expected for a broken build)"
  done
  stop_bot
done

echo
echo "Done: $SUITES suites saved to .evals/runs. Refresh the dashboard and the new items are in Classify."
