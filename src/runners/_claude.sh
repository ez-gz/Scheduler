#!/usr/bin/env bash
# Shared Claude Code runner logic.
# Called by model-specific wrappers that set $MODEL before sourcing this file.
#
# Env vars (set by runner registry in index.js):
#   TASK_ID       — unique task id
#   TASK_TEXT     — full task description
#   TASK_DIR      — directory to run in
#   TASK_WORKTREE — "true" to create a worktree
#   TASK_DURABLE_WORKTREE — "true" to keep worktree after completion/failure

set -euo pipefail

: "${MODEL:?MODEL must be set by the calling runner script}"
: "${TASK_TEXT:?TASK_TEXT is required}"
: "${TASK_DIR:?TASK_DIR is required}"
: "${TASK_ID:?TASK_ID is required}"

TASK_WORKTREE="${TASK_WORKTREE:-false}"
TASK_DURABLE_WORKTREE="${TASK_DURABLE_WORKTREE:-false}"

RUNNER_NAME="claude-${MODEL}"
echo "[${RUNNER_NAME}] task=$TASK_ID model=$MODEL worktree=$TASK_WORKTREE durable=$TASK_DURABLE_WORKTREE"
echo "[${RUNNER_NAME}] dir=$TASK_DIR"

if [ "$TASK_WORKTREE" = "true" ]; then
  BRANCH="scheduler/${TASK_ID}"
  REPO_ROOT=$(cd "$TASK_DIR" && git rev-parse --show-toplevel)
  WORKTREE_PATH="${REPO_ROOT}/../worktree-${TASK_ID}"
  echo "[SCHEDULER_WORKTREE] {\"repoRoot\":\"$REPO_ROOT\",\"path\":\"$WORKTREE_PATH\",\"branch\":\"$BRANCH\",\"durable\":$TASK_DURABLE_WORKTREE}"

  echo "[${RUNNER_NAME}] creating worktree: branch=$BRANCH path=$WORKTREE_PATH"
  cd "$REPO_ROOT"
  git worktree add -b "$BRANCH" "$WORKTREE_PATH"

  echo "[${RUNNER_NAME}] phase 1: running task in worktree"
  cd "$WORKTREE_PATH"
  claude --model "$MODEL" --dangerously-skip-permissions -p "$TASK_TEXT"

  echo "[${RUNNER_NAME}] phase 2: committing and pushing branch"
  PUSH_PROMPT="The implementation task has just completed in branch '${BRANCH}'.

Please do the following:
1. Stage and commit any uncommitted changes with a clear, descriptive commit message.
2. Run: git push origin ${BRANCH}
3. Run: gh pr create --title \"<short summary of the task>\" --body \"<what was done and why>\"

The original task was:
${TASK_TEXT}"

  claude --model "$MODEL" --dangerously-skip-permissions -p "$PUSH_PROMPT"

  cd "$REPO_ROOT"
  if [ "$TASK_DURABLE_WORKTREE" = "true" ]; then
    echo "[SCHEDULER_WORKTREE_KEPT] $WORKTREE_PATH"
    echo "[${RUNNER_NAME}] durable worktree kept at $WORKTREE_PATH"
  else
    git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    echo "[SCHEDULER_WORKTREE_REMOVED] $WORKTREE_PATH"
    echo "[${RUNNER_NAME}] worktree removed, branch $BRANCH is on remote"
  fi

else
  cd "$TASK_DIR"
  echo "[${RUNNER_NAME}] running task in-place"

  RESUME_FLAGS=""
  if [ -n "${TASK_RESUME_SESSION_ID:-}" ]; then
    RESUME_FLAGS="--resume $TASK_RESUME_SESSION_ID"
    [ "${TASK_FORK_SESSION:-false}" = "true" ] && RESUME_FLAGS="$RESUME_FLAGS --fork-session"
    echo "[${RUNNER_NAME}] resuming session=$TASK_RESUME_SESSION_ID fork=${TASK_FORK_SESSION:-false}"
  fi

  CLAUDE_JSON=$(claude --model "$MODEL" --dangerously-skip-permissions $RESUME_FLAGS -p "$TASK_TEXT" --output-format json)
  echo "$CLAUDE_JSON"
  SESSION_ID=$(python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('session_id',''))" <<< "$CLAUDE_JSON" 2>/dev/null || true)
  [ -n "$SESSION_ID" ] && echo "[SCHEDULER_SESSION_ID] $SESSION_ID"
fi

echo "[${RUNNER_NAME}] done"
