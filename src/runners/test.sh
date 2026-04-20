#!/usr/bin/env bash
# Test runner — no claude invocation, no token cost.
# Lists TASK_DIR and writes output to /tmp/sched-out-$TASK_ID.txt
# Use runner: "test" in the queue to exercise the full scheduler machinery.

set -euo pipefail

: "${TASK_ID:?TASK_ID required}"
: "${TASK_DIR:?TASK_DIR required}"

OUT="/tmp/sched-out-${TASK_ID}.txt"

echo "[test runner] task=$TASK_ID dir=$TASK_DIR"
echo "[test runner] writing output to $OUT"

{
  echo "=== Scheduler Test Run ==="
  echo "Task ID : $TASK_ID"
  echo "Task    : ${TASK_TEXT:-<none>}"
  echo "Dir     : $TASK_DIR"
  echo "Time    : $(date)"
  echo ""
  echo "--- Directory listing: $TASK_DIR ---"
  ls -lah "$TASK_DIR"
} | tee "$OUT"

echo "[test runner] done. output at $OUT"
