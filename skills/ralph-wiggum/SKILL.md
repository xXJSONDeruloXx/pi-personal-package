---
name: ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

Use the `ralph_start` tool to begin a loop:

```
ralph_start({
  name: "loop-name",
  taskContent: "# Task\n\n## Goals\n- Goal 1\n\n## Checklist\n- [ ] Item 1\n- [ ] Item 2",
  maxIterations: 50,        // Default: 50
  itemsPerIteration: 3,     // Optional: suggest N items per turn
  reflectEvery: 10,         // Optional: reflect every N iterations
  compactEachRound: true    // Default: compact context before each new round
})
```

## Loop Behavior

1. **Write the task file**: Create `.ralph/<name>.md` with the task content. The tool does NOT create this file—you must write it yourself using the Write tool.
2. Work on the task and update the file each iteration.
3. Record verification evidence (commands run, file paths, outputs) in the task file.
4. By default, Ralph compacts context before queuing the next iteration unless `compactEachRound: false` is used.
5. **Call the `ralph_done` tool** to proceed to the next iteration (see below).
6. Output `<promise>COMPLETE</promise>` when finished.
7. Stop when complete or when max iterations is reached (default 50).

## User Commands

- `/ralph start <name|path> [--no-compact-each-round]` - Start a new loop.
- `/ralph resume <name>` - Resume loop.
- `/ralph stop` - Pause loop (when agent idle).
- `/ralph next` - Manually advance to next iteration (fallback when `ralph_done` tool call fails).
- `/ralph-stop` - Stop active loop (idle only).
- `/ralph status` - Show loops.
- `/ralph list --archived` - Show archived loops.
- `/ralph archive <name>` - Move loop to archive.
- `/ralph clean [--all]` - Clean completed loops.
- `/ralph cancel <name>` - Delete loop.
- `/ralph nuke [--yes]` - Delete all .ralph data.

Press ESC to interrupt streaming, send a normal message to resume, and run `/ralph-stop` when idle to end the loop.

## Task File Format

```markdown
# Task Title

Brief description.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2
- [x] Completed item

## Verification
- Evidence, commands run, or file paths

## Notes
(Update with progress, decisions, blockers)
```

## Calling `ralph_done` (Critical)

`ralph_done` is a **tool call** — not text in your response. Invoke it through the tool-calling mechanism with an empty arguments object `{}`.

**When to call it:**
- After completing work in the current iteration
- After updating the `.ralph/<name>.md` task file with progress
- **Never** output the word "ralph_done" as text in your response
- **Never** wrap it in code blocks, quotes, or markdown

**What happens next:**
1. Pi receives the tool call and advances the loop counter
2. Context is compacted (if `compactEachRound: true`)
3. You receive the next iteration's task prompt

**Common mistakes to avoid:**
- ❌ Writing "I'll call ralph_done now" as text (invoke the tool instead)
- ❌ Outputting `ralph_done()` or `ralph_done({})` as text/code (these are tool invocations, not response text)
- ❌ Confusing `ralph_done` with `<promise>COMPLETE</promise>`:
  - `ralph_done` tool call = advance to next iteration (loop continues)
  - `<promise>COMPLETE</promise>` text = end the entire loop (all done)

## Best Practices

1. Write a clear checklist with discrete items.
2. Update checklist and notes as you go.
3. Treat the task file as canonical memory, especially with default per-round compaction.
4. Capture verification evidence for completed items.
5. Reflect when stuck to reassess approach.
6. Output the completion marker only when truly done.
