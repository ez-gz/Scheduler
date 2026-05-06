# Claude vs Codex Rendering Delta Report

Date: 2026-05-06

## Summary

The app already renders both runners, but the two output formats are not equivalent.
Claude output is centered on assistant message blocks and tool-use content, while Codex output is centered on streamed JSONL events such as command execution, file changes, and completed agent messages.

## What Renders Better For Claude

- Assistant text and inline markdown are easy to render directly from `assistant.message.content`.
- Tool calls are explicit and compact, so the UI can show them as expandable details without extra parsing.
- Usage is exposed in a single `result` event, which makes token display straightforward.

## What Renders Better For Codex

- Codex JSONL contains richer task-level events, especially `command_execution` and `file_change`.
- The UI can show command output and file diffs as structured details instead of flattening everything into a chat transcript.
- Final assistant output is usually easy to extract from `item.completed` events with `agent_message` items.

## Main Delta

- Claude is better represented as a conversational transcript with tool blocks.
- Codex is better represented as an execution log with terminal-like artifacts.
- The current renderer reflects that split, but it also means the two runners feel visually different in the same task list.

## Recommendation

- Keep the current runner-specific parsing.
- Preserve the structured Codex event rendering for command output and file changes.
- Keep Claude’s markdown-first message rendering.
- If a single visual style is desired later, normalize both streams into a shared intermediate event model before rendering.

