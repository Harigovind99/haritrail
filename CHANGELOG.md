# Changelog

## 1.0.0 (2026-10-08)

First release.

- Journey view: every prompt and each move Claude Code made, live, with what Claude said before each move, messages you sent while it worked, the final answer, and where the prompt came from (terminal, VS Code chat panel or desktop app).
- Trail Map: a map of your codebase with Claude's path drawn in order, a Lanes view of moves over time, and replay with speed control and editor sync.
- Phase ribbon (Explore, Change, Verify) and notes on fix loops, the test trend, most visited files, how much Claude looked around before its first change, and subagents.
- Footprints: Explorer badges for files Claude read (R), edited (E) or created (N), and a Footprints view grouped by folder.
- Ink marks: lines Claude changed are highlighted in the editor, with a hover that links to the exact change.
- Ride-Along: the editor follows Claude from file to file while it works.
- Full-file before and after diffs for each change, command output, and subagent moves nested under the task that started them.
- Export Journey Report to Markdown, with a Mermaid diagram of the path.
- Works with Claude Code in the terminal and in the VS Code chat panel. Automatic messages (background task notices, editor context) are never shown as your prompts.
