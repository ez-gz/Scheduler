#!/usr/bin/env bash
# Shared Codex runner logic.
# Called by model-specific wrappers that set $MODEL before sourcing this file.
#
# Env vars (set by runner registry in index.js):
#   TASK_ID       — unique task id
#   TASK_TEXT     — full task description piped into codex exec via stdin
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
CODEX_BIN="${CODEX_BIN:-codex}"

RUNNER_NAME="codex-${MODEL}"
echo "[${RUNNER_NAME}] task=$TASK_ID model=$MODEL worktree=$TASK_WORKTREE durable=$TASK_DURABLE_WORKTREE"
echo "[${RUNNER_NAME}] dir=$TASK_DIR"

run_codex() {
  local dir="$1"
  local prompt="$2"
  cd "$dir"
  echo "$prompt" | "$CODEX_BIN" exec - \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    --model "$MODEL"
}

run_codex_json() {
  local dir="$1"
  local prompt="$2"
  cd "$dir"
  echo "$prompt" | "$CODEX_BIN" exec - --json \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    --model "$MODEL"
}

run_codex_resume() {
  local dir="$1"
  local prompt="$2"
  local session_id="$3"
  cd "$dir"
  echo "$prompt" | "$CODEX_BIN" exec resume "$session_id" --json \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    --model "$MODEL"
}

if [ "$TASK_WORKTREE" = "true" ]; then
  BRANCH="scheduler/${TASK_ID}"
  REPO_ROOT=$(cd "$TASK_DIR" && git rev-parse --show-toplevel)
  WORKTREE_PATH="${REPO_ROOT}/../worktree-${TASK_ID}"
  echo "[SCHEDULER_WORKTREE] {\"repoRoot\":\"$REPO_ROOT\",\"path\":\"$WORKTREE_PATH\",\"branch\":\"$BRANCH\",\"durable\":$TASK_DURABLE_WORKTREE}"

  echo "[${RUNNER_NAME}] creating worktree: branch=$BRANCH path=$WORKTREE_PATH"
  cd "$REPO_ROOT"
  git worktree add -b "$BRANCH" "$WORKTREE_PATH"

  echo "[${RUNNER_NAME}] phase 1: running task in worktree"
  run_codex "$WORKTREE_PATH" "$TASK_TEXT"

  echo "[${RUNNER_NAME}] phase 2: committing and pushing branch"
  PUSH_PROMPT="The implementation task has just completed in branch '${BRANCH}'.

Please do the following:
1. Stage and commit any uncommitted changes with a clear, descriptive commit message.
2. Run: git push origin ${BRANCH}
3. Run: gh pr create --title \"<short summary>\" --body \"<what was done and why>\"

The original task was:
${TASK_TEXT}"

  run_codex "$WORKTREE_PATH" "$PUSH_PROMPT"

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
  echo "[${RUNNER_NAME}] running task in-place"

  if [ -n "${TASK_RESUME_SESSION_ID:-}" ]; then
    echo "[${RUNNER_NAME}] resuming session=$TASK_RESUME_SESSION_ID"
    CODEX_OUTPUT=$(run_codex_resume "$TASK_DIR" "$TASK_TEXT" "$TASK_RESUME_SESSION_ID")
  else
    CODEX_OUTPUT=$(run_codex_json "$TASK_DIR" "$TASK_TEXT")
  fi

  echo "$CODEX_OUTPUT"
  SESSION_ID=$(echo "$CODEX_OUTPUT" | head -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('thread_id',''))" 2>/dev/null || true)
  [ -n "$SESSION_ID" ] && echo "[SCHEDULER_SESSION_ID] $SESSION_ID"
fi

echo "[${RUNNER_NAME}] done"
