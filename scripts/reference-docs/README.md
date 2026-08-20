# Codex reference documentation workflow

This workflow drives the Tea reference rewrite through a serial, resumable set
of `codex exec` runs. It is deliberately not an in-process agent swarm. Each
Codex turn owns one bounded workstream, edits the same worktree, returns a
schema-checked result, and must pass that workstream's validation before the
next turn starts.

The workflow follows the Codex CLI's documented non-interactive pattern:
JSONL events for progress, a JSON Schema for the final result, a persisted
session ID for repair turns, and the `workspace-write` sandbox. See the
[OpenAI Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode.md).

## Safety model

- Run from a dedicated branch or worktree.
- A clean worktree is required by default.
- The workflow never commits, pushes, opens pull requests, or bypasses the
  sandbox.
- Tasks run serially to avoid overlapping edits.
- The Git HEAD must not change during a run.
- Changed paths must stay within the scope file's allowlist.
- A blocked task or exhausted validation retry stops the run.
- Run state is written under `.codex/reference-docs/`, which is ignored by Git.

Use `--allow-dirty` only when you have separately backed up and reviewed the
existing changes. The workflow can identify unexpected paths, but it cannot
reliably distinguish an agent's edit from a pre-existing edit to the same file.

## Commands

Preview the complete task list without calling Codex:

```sh
bun scripts/reference-docs/workflow.ts plan
```

Start a new run:

```sh
bun scripts/reference-docs/workflow.ts run
```

Inspect available runs or one run:

```sh
bun scripts/reference-docs/workflow.ts status
bun scripts/reference-docs/workflow.ts status <run-id>
```

Resume an interrupted or blocked run after addressing its external blocker:

```sh
bun scripts/reference-docs/workflow.ts resume <run-id>
```

Approve a declared human-review gate only after its feedback has been applied
to the scope and workflow:

```sh
bun scripts/reference-docs/workflow.ts approve <run-id> <gate-id>
```

The default scope contains a mandatory `pilot-review` gate after the seven
representative pages. A run cannot continue into exhaustive generation until
that gate is explicitly approved.

Useful options:

```text
--scope <file>          Scope file (default: scripts/reference-docs/scope.json)
--model <model>         Codex model override; otherwise use configured default
--only <a,b,c>          Run only named workstreams and their desired features
--from <task-id>        Skip tasks before this task
--max-retries <n>       Validation repair turns per task (default: 2)
--allow-dirty           Permit a dirty starting worktree
--run-id <id>           Explicit run id for `run`
```

The environment variable `TEA_DOCS_CODEX_MODEL` is equivalent to `--model`.

## Current and desired scope

[`scope.json`](./scope.json) defines the current public categories, source-of-
truth files, publication rules, exclusions, allowed paths, workstreams, and
validation commands.

Current compiler scope is always inventoried at run start. Do not add a missing
feature to the public reference merely because a parser or catalog entry exists.

To require a desired feature that Tea does not yet implement, add an item to
`desiredFeatures`:

```json
{
  "id": "example-feature",
  "kind": "language",
  "specification": "A complete source-observable semantic contract...",
  "acceptance": [
    "A valid program and its exact result",
    "An invalid program and its exact diagnostic",
    "CPU rollback and history behavior where applicable"
  ],
  "allowedPaths": ["src/", "tests/", "docs/reference/", "website/scripts/"],
  "validate": ["bun run check"]
}
```

The specification and acceptance list are mandatory. Codex must first implement
and verify that language/runtime feature, then the later category workstream
documents it. This prevents the documentation workflow from inventing semantics
for an underspecified future feature.

## Run artifacts

Each run stores:

```text
.codex/reference-docs/<run-id>/
├── state.json
├── scope.snapshot.json
├── inventory.json
├── result.schema.json
└── tasks/<task-id>/
    ├── prompt.md
    ├── attempt-1.events.jsonl
    ├── attempt-1.stderr.log
    ├── attempt-1.final.json
    └── attempt-1.validation.log
```

`thread.started` IDs from the JSONL stream are recorded in `state.json`.
Validation failures resume that exact Codex session with the failing command
output, so the repair turn keeps the context of the work it just performed.

## Human review

The workflow is exhaustive, but it is not authority to publish blindly. Before
committing:

1. Review the generated route inventory and category totals.
2. Open representative pages with `tea docs`.
3. Review the diff for language claims and accidental scope expansion.
4. Commit only after the final validation workstream passes and a human accepts
   the writing quality.
