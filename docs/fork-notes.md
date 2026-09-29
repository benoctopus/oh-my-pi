# Fork notes: per-spawn model selection

This checkout is a fork of `can1357/oh-my-pi` on branch `feat/spawn-model`.

Upstream removed per-call model overrides in `9f8aa87dbf` (task tool) and `b8779dae63` (eval `agent()`, issue #6438). This branch reintroduces them as a validated per-spawn `model` field.

## Remotes

- `upstream` = `https://github.com/can1357/oh-my-pi.git`
- `origin` = the fork on GitHub

## Rebase procedure

```bash
git fetch upstream --tags
git rebase <new-release-tag>   # e.g. v18.5.0
bun setup
bun run check:ts && bun --cwd=packages/coding-agent test
```

Resolve conflicts in the touched surfaces below, then rerun the checks.

## Touched surfaces

| Surface | Field | Files |
|---|---|---|
| `task`, batch and flat shapes | `model` | `src/task/types.ts`, `src/task/index.ts` |
| eval `agent()` | `model=` / `{ model }` | `src/eval/py/prelude.py`, `src/eval/js/shared/prelude.txt`, `src/eval/agent-bridge.ts` |
| eval `workpool()` | `model=` | prelude files, `src/eval/workpool-bridge.ts`, `src/task/workpool.ts` |
| Validation and resolution | `StructuredSubagentRequest.spawnModel` | `src/task/spawn-model.ts` (new), `resolveEffectiveSubagentPolicy`, `src/task/executor.ts` (`spawnEffortCeiling`) |

Settings: `task.spawnModel` (default `true`), `task.spawnModelAliases` (default `[]`).

Prompt: the `task` tool description renders a `model` section (aliases grouped by supported efforts), frozen with the base prompt surface.

Behaviour: precedence spawn `model` > `task.agentModelOverrides` > frontmatter `model` > parent; a `before_subagent_spawn` hook may still replace it; suffix plus coarse `effort` is rejected; a suffix above `task.maxEffort` is rejected and the ceiling carries across retry fallbacks; no parent-auth fallback for an explicit spawn model.

Design: `docs/superpowers/specs/2026-09-28-spawn-model-selection-design.md`.
