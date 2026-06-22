#!/usr/bin/env bash
# Provider-neutral interactive tmux runner logic.
# Provider wrappers configure AGENT_* variables, then source this file.

set -euo pipefail

: "${MODEL:?MODEL must be set by the calling runner script}"
: "${TASK_TEXT:?TASK_TEXT is required}"
: "${TASK_DIR:?TASK_DIR is required}"
: "${TASK_ID:?TASK_ID is required}"
: "${AGENT_PROVIDER:?AGENT_PROVIDER is required}"
: "${AGENT_BIN:?AGENT_BIN is required}"
: "${AGENT_READY_REGEX:?AGENT_READY_REGEX is required}"

TASK_WORKTREE="${TASK_WORKTREE:-false}"
TASK_DURABLE_WORKTREE="${TASK_DURABLE_WORKTREE:-false}"
INTERACTIVE_TMUX_TIMEOUT_SECONDS="${INTERACTIVE_TMUX_TIMEOUT_SECONDS:-21600}"
INTERACTIVE_TMUX_STARTUP_TIMEOUT_SECONDS="${INTERACTIVE_TMUX_STARTUP_TIMEOUT_SECONDS:-45}"
INTERACTIVE_TMUX_POLL_SECONDS="${INTERACTIVE_TMUX_POLL_SECONDS:-1}"
INTERACTIVE_TMUX_KEEP_SESSION_ON_DONE="${INTERACTIVE_TMUX_KEEP_SESSION_ON_DONE:-true}"

RUNNER_NAME="${AGENT_PROVIDER}-tmux-${MODEL}"
RUN_ID="$(date +%s)-$$"
SESSION_NAME="scheduler-task-${TASK_ID}-${RUN_ID}"
TERMINAL_ID="task-${TASK_ID}-${RUN_ID}"
TARGET="${SESSION_NAME}:0.0"
SESSION_STARTED="false"

echo "[${RUNNER_NAME}] task=$TASK_ID model=$MODEL worktree=$TASK_WORKTREE durable=$TASK_DURABLE_WORKTREE"
echo "[${RUNNER_NAME}] dir=$TASK_DIR"

if [[ "$AGENT_BIN" != */* ]]; then
  AGENT_BIN="$(command -v "$AGENT_BIN")"
fi

shell_quote() {
  printf "%q" "$1"
}

shell_join() {
  local out="" arg
  for arg in "$@"; do
    out="${out} $(shell_quote "$arg")"
  done
  printf "%s" "${out# }"
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

capture_pane() {
  tmux capture-pane -p -e -S -1200 -t "$TARGET" 2>/dev/null || true
}

kill_session() {
  if [ "$SESSION_STARTED" = "true" ] && session_exists; then
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  fi
}

emit_tmux_meta() {
  local cwd="$1"
  python3 - "$TERMINAL_ID" "$SESSION_NAME" "$RUNNER_NAME" "$cwd" "$TASK_ID" "$AGENT_PROVIDER" <<'PY'
import json
import sys

terminal_id, session_name, runner, cwd, task_id, provider = sys.argv[1:]
print("[SCHEDULER_TMUX_SESSION] " + json.dumps({
    "id": terminal_id,
    "terminalId": terminal_id,
    "sessionName": session_name,
    "name": f"{runner} {task_id}",
    "cwd": cwd,
    "backend": "tmux",
    "mode": "interactive-tmux",
    "provider": provider,
    "runner": runner,
    "taskId": task_id,
}, separators=(",", ":")))
PY
}

build_agent_command() {
  local command_args=(env)
  local var_name

  if declare -p AGENT_UNSET_ENV_VARS >/dev/null 2>&1; then
    for var_name in "${AGENT_UNSET_ENV_VARS[@]}"; do
      command_args+=(-u "$var_name")
    done
  fi

  command_args+=("$AGENT_BIN")

  if declare -p AGENT_ARGS >/dev/null 2>&1; then
    command_args+=("${AGENT_ARGS[@]}")
  fi

  if [ -n "${TASK_RESUME_SESSION_ID:-}" ] && [ -n "${AGENT_RESUME_FLAG:-}" ]; then
    command_args+=("$AGENT_RESUME_FLAG" "$TASK_RESUME_SESSION_ID")
    if [ "${TASK_FORK_SESSION:-false}" = "true" ] && [ -n "${AGENT_FORK_FLAG:-}" ]; then
      command_args+=("$AGENT_FORK_FLAG")
    fi
    echo "[${RUNNER_NAME}] resuming session=$TASK_RESUME_SESSION_ID fork=${TASK_FORK_SESSION:-false}" >&2
  fi

  shell_join "${command_args[@]}"
}

launch_agent() {
  local cwd="$1"
  local launch_command
  launch_command="$(build_agent_command)"

  echo "[${RUNNER_NAME}] launching tmux session=$SESSION_NAME"
  tmux new-session -d -s "$SESSION_NAME" -c "$cwd" "$launch_command"
  SESSION_STARTED="true"
  emit_tmux_meta "$cwd"
}

wait_for_agent_ready() {
  local deadline=$((SECONDS + INTERACTIVE_TMUX_STARTUP_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! session_exists; then
      echo "[${RUNNER_NAME}] tmux session exited before ${AGENT_PROVIDER} became ready"
      capture_pane
      return 1
    fi

    local pane
    pane="$(capture_pane)"
    if printf "%s" "$pane" | grep -Eiq "$AGENT_READY_REGEX"; then
      return 0
    fi

    sleep 1
  done

  echo "[${RUNNER_NAME}] ${AGENT_PROVIDER} prompt did not become ready within ${INTERACTIVE_TMUX_STARTUP_TIMEOUT_SECONDS}s"
  capture_pane
  return 1
}

make_prompt_file() {
  local prompt="$1"
  local marker_id="$2"
  local file="$3"

  {
    printf "%s\n\n" "$prompt"
    printf "Scheduler completion contract:\n"
    printf "When the task is completely finished, include the completion marker formed by concatenating these three strings on its own line:\n"
    printf '"[SCHEDULER_DONE:"\n'
    printf '"%s"\n' "$marker_id"
    printf '"]"\n\n'
    printf "Do not print that marker until the task is actually complete.\n"
  } > "$file"
}

send_prompt() {
  local prompt="$1"
  local marker_id="$2"
  local prompt_file buffer_name
  prompt_file="$(mktemp "${TMPDIR:-/tmp}/scheduler-agent-prompt.XXXXXX")"
  buffer_name="scheduler-${TASK_ID}-${marker_id//[^A-Za-z0-9_]/_}"

  make_prompt_file "$prompt" "$marker_id" "$prompt_file"
  tmux load-buffer -b "$buffer_name" "$prompt_file"
  tmux paste-buffer -p -d -b "$buffer_name" -t "$TARGET"
  tmux send-keys -t "$TARGET" Enter
  rm -f "$prompt_file"
}

wait_for_marker() {
  local marker_id="$1"
  local phase="$2"
  local marker="[SCHEDULER_DONE:${marker_id}]"
  local deadline=$((SECONDS + INTERACTIVE_TMUX_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! session_exists; then
      echo "[${RUNNER_NAME}] tmux session exited while waiting for phase=$phase"
      capture_pane
      return 1
    fi

    local pane
    pane="$(capture_pane)"
    if printf "%s" "$pane" | grep -Fq "$marker"; then
      sleep 2
      echo "[SCHEDULER_TMUX_DONE] phase=$phase marker=$marker"
      echo "[SCHEDULER_TMUX_CAPTURE_BEGIN]"
      capture_pane
      echo "[SCHEDULER_TMUX_CAPTURE_END]"
      return 0
    fi

    sleep "$INTERACTIVE_TMUX_POLL_SECONDS"
  done

  echo "[${RUNNER_NAME}] timed out after ${INTERACTIVE_TMUX_TIMEOUT_SECONDS}s waiting for phase=$phase marker=$marker"
  echo "[SCHEDULER_TMUX_CAPTURE_BEGIN]"
  capture_pane
  echo "[SCHEDULER_TMUX_CAPTURE_END]"
  return 1
}

run_phase() {
  local prompt="$1"
  local phase="$2"
  local marker_id="${TASK_ID}:${phase}"

  echo "[${RUNNER_NAME}] sending phase=$phase prompt"
  send_prompt "$prompt" "$marker_id"
  wait_for_marker "$marker_id" "$phase"
}

if [ "$TASK_WORKTREE" = "true" ]; then
  BRANCH="scheduler/${TASK_ID}"
  REPO_ROOT=$(cd "$TASK_DIR" && git rev-parse --show-toplevel)
  WORKTREE_PATH="${REPO_ROOT}/../worktree-${TASK_ID}"
  echo "[SCHEDULER_WORKTREE] {\"repoRoot\":\"$REPO_ROOT\",\"path\":\"$WORKTREE_PATH\",\"branch\":\"$BRANCH\",\"durable\":$TASK_DURABLE_WORKTREE}"

  echo "[${RUNNER_NAME}] creating worktree: branch=$BRANCH path=$WORKTREE_PATH"
  cd "$REPO_ROOT"
  git worktree add -b "$BRANCH" "$WORKTREE_PATH"

  launch_agent "$WORKTREE_PATH"
  wait_for_agent_ready

  echo "[${RUNNER_NAME}] phase 1: running task in worktree"
  run_phase "$TASK_TEXT" "task"

  echo "[${RUNNER_NAME}] phase 2: committing and pushing branch"
  PUSH_PROMPT="The implementation task has just completed in branch '${BRANCH}'.

Please do the following:
1. Stage and commit any uncommitted changes with a clear, descriptive commit message.
2. Run: git push origin ${BRANCH}
3. Run: gh pr create --title \"<short summary of the task>\" --body \"<what was done and why>\"

The original task was:
${TASK_TEXT}"

  run_phase "$PUSH_PROMPT" "publish"

  cd "$REPO_ROOT"
  if [ "$TASK_DURABLE_WORKTREE" = "true" ]; then
    echo "[SCHEDULER_WORKTREE_KEPT] $WORKTREE_PATH"
    echo "[${RUNNER_NAME}] durable worktree kept at $WORKTREE_PATH"
  else
    kill_session
    git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    echo "[SCHEDULER_WORKTREE_REMOVED] $WORKTREE_PATH"
    echo "[${RUNNER_NAME}] worktree removed, branch $BRANCH is on remote"
  fi
else
  cd "$TASK_DIR"
  echo "[${RUNNER_NAME}] running task in-place"

  launch_agent "$TASK_DIR"
  wait_for_agent_ready
  run_phase "$TASK_TEXT" "task"

  if [ "$INTERACTIVE_TMUX_KEEP_SESSION_ON_DONE" != "true" ]; then
    kill_session
  fi
fi

echo "[${RUNNER_NAME}] done"
