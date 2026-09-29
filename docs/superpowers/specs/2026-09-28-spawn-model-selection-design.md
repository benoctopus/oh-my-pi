# Spawn-level model selection — design

Date: 2026-09-28
Base: `can1357/oh-my-pi` tag `v18.4.2`, branch `feat/spawn-model` in `~/code/oh-my-pi`
Status: approved in brainstorming; pending written-spec review

## 1. Intent

**Stated by the user**

- Ad hoc general-purpose subagents must be dispatchable on a user-named model and effort, to use different vendors where each is strongest.
- The user names models in plain language inside ordinary requests, e.g. "brainstorming, use gpt sol for spec review" or "implement with the subagent-driven workflow, glm flash with high effort as the implementer and sonnet for the reviewer".
- Effort is part of the choice and must be literal: "high" means `high`, not the model's top level.
- Routing policy A: the orchestrator sets a model only when the user names one. Autonomous vendor routing is out of scope.
- Delivery: a personal fork of oh-my-pi, run as the daily `omp`; upstreaming is decided later.

**Assumed**

- `adversarial-review` stays and migrates onto the new mechanism.
- Success: any session can dispatch any agent on `@alias[:effort]`; changing the model lineup is a `config.yml` edit; no per-model agent files exist.

## 2. Background (verified against v18.4.2)

- `StructuredSubagentRequest.model` (`packages/coding-agent/src/task/structured-subagent.ts`) already exists, and `resolveEffectiveAgentModelSelection` (`src/config/model-resolver.ts`) ranks `requestModel` above `task.agentModelOverrides` and agent frontmatter `model`. Neither the `task` tool schema nor eval `agent()`/`workpool()` populates it.
- `resolveConfiguredRolePattern` splits a `:level` thinking suffix, so `@sol:high` expands to `<sol selector>:high`.
- An unresolvable request pattern currently resolves to `[]` and resolution silently falls through to the next source (settings override, agent model, parent model). This design must not inherit that behaviour.
- Coarse `effort` (`lo`/`med`/`hi`, `task.enableEffort`) is relative: `resolveTaskEffortLevel` maps `hi` to the model's highest supported level (`max` on every model in scope). It cannot express literal levels.
- Catalog-supported efforts (from `models.db`): Anthropic and OpenAI models in scope support `low medium high xhigh max`; `zai/glm-5.3` and `zai/glm-5.3-flash` support `low high max`.
- `before_subagent_spawn` fires once per spawned child after policy resolution and may replace the model.

## 3. Design

### 3.1 Spawn `model` field (fork change)

**Surfaces**

| Surface | Field | File (expected) |
|---|---|---|
| `task`, batch shape | per-item `model?: string` | `src/task/types.ts` (`taskItemSchema`), `src/task/index.ts` |
| `task`, flat shape | top-level `model?: string` | same |
| eval `agent()` | Python `agent(prompt, model=None, …)`; JS `{ model }` option | `src/eval/py/prelude.py`, `src/eval/js/shared/prelude.txt`, `src/eval/agent-bridge.ts` |
| eval `workpool()` | `workpool(agent=None, *, model=None, …)`; applies to every worker in the pool | `src/eval/py/prelude.py`, `src/eval/js/shared/prelude.txt`, `src/eval/workpool-bridge.ts`, `src/task/workpool.ts` |

**Value**: exactly one selector string, either `@<alias>` or `@<alias>:<effort>`, or a concrete catalog selector `provider/id` optionally with `:<effort>`. Arrays are rejected; fallback chains remain the job of `retry.fallbackChains`.

**Wiring**: each surface forwards the value unchanged into a new `StructuredSubagentRequest.spawnModel` field. The existing `StructuredSubagentRequest.model` stays internal and unvalidated because `src/cleanse/agent.ts` passes arbitrary selectors through it. After validation (3.4), the validated patterns feed the existing `requestModel` slot. No new precedence logic: that slot already outranks `task.agentModelOverrides` and frontmatter.

**Agent identity is unchanged.** The `agent` still supplies system prompt, tools, spawns, output schema, advisor, prewalk. `model` only replaces model and effort. Example: `{ agent: "reviewer", model: "@sonnet" }`.

**Effort precedence**

1. Suffix on `model` (e.g. `:high`) wins over the agent's `thinkingLevel`, including the bundled `task` agent's `auto`.
2. No suffix: the agent's configured `thinkingLevel` applies, as today.
3. Suffix **and** coarse `effort` on the same spawn: rejected (see 3.4).
4. `task.maxEffort` applies to suffix effort too. Today the ceiling is only armed when coarse `effort` is set (`src/task/executor.ts`, `spawnEffortCeiling`), so a suffix would bypass it. For a spawn `model` with a suffix: a suffix above `task.maxEffort` fails preflight (no silent clamp, see 3.4), and `spawnEffortCeiling` is set to `task.maxEffort` so retry-fallback model switches cannot raise effort past it. A spawn `model` without a suffix keeps today's ceiling behaviour.

**Hooks**: `before_subagent_spawn` runs after this resolution and may still replace the model; existing routing extensions keep working.

**Visibility**: the resolved model and level appear where the resolved model already appears (task UI row, Agent Hub, `SingleResult.resolvedModel`/`modelRole`).

### 3.2 Settings

| Key | Type | Default (fork) | Meaning |
|---|---|---|---|
| `task.spawnModel` | boolean | `true` | When `false`, the `model` field is omitted from `task` schema and description, and `agent()`/`workpool()` reject `model`. Same exposure pattern as `task.enableEffort`. |
| `task.spawnModelAliases` | string[] | `[]` | Role names from `modelRoles` that are valid `@alias` targets for spawn `model` and are listed in the tool description. |

Only roles listed in `task.spawnModelAliases` are accepted as `@alias` values for spawn `model`. Concrete `provider/id[:effort]` selectors are accepted whenever `task.spawnModel` is on, subject to 3.4.

### 3.3 Orchestrator guidance (task tool description)

When `task.spawnModel` is on, the `task` tool description renders a `model` section. The same content serves eval `agent()`/`workpool()` because the orchestrator reads it from the `task` description; the eval agent docs gain a one-line pointer to it.

Rendered shape (aliases grouped by identical supported-effort sets):

```
model: optional "@alias[:effort]". Set ONLY when the user names a model for this spawn.
Map the user's wording ("glm flash", "gpt sol", "Sonnet", "high effort") to an alias and literal effort.
Unlisted or ambiguous model, or an effort the model lacks: ask the user; never guess.
  @sonnet @opus @fable @sol @astra @luna @terra  efforts: low medium high xhigh max
  @glm @glm-flash                                efforts: low high max
```

- Efforts per alias come from the resolved catalog model's supported efforts.
- The section is computed when the base prompt surface is built and frozen for the session, like user-tagged model agents, so the provider cache prefix stays byte-stable. Alias changes take effect at the next base-prompt rebuild or session.
- No skill and no system-prompt change: the guidance travels with the tool wherever `task` is available.

### 3.4 Errors

All of these fail **preflight** (inside `resolveEffectiveSubagentPolicy`, before id allocation or subprocess launch). The error reaches the orchestrator as a tool error and names the valid options.

| Condition | Message shape |
|---|---|
| `@alias` not in `task.spawnModelAliases` (including roles that exist in `modelRoles` but are not listed) | `Unknown model alias "@solx". Available: @sonnet, @opus, …` |
| Alias listed but its role resolves to no available model | `Model alias "@sol" resolves to no available model (<selector>).` |
| Concrete selector not in the available catalog | `Unknown model "<selector>".` |
| Effort not supported by the resolved model | `glm-5.3 does not support effort "medium". Supported: low, high, max.` |
| Suffix and `effort` both set | `Set effort either as a model suffix or via "effort", not both.` |
| Suffix effort above `task.maxEffort` | `Effort "max" exceeds task.maxEffort ("high").` |
| `model` set while `task.spawnModel` is `false` | `Spawn model selection is disabled (task.spawnModel).` |
| `model` is an array or empty string | schema validation error |
| Session has no model registry (`ToolSession.modelRegistry` undefined) | `Spawn model selection needs a model registry.` |

No silent fallback anywhere on the explicit-`model` path: the parent-model auth fallback used for unresolved patterns must not apply when the source is a spawn `model`. Runtime failures after a valid model starts (quota, auth, provider outage) keep today's behaviour (`retry.fallbackChains`, error attribution).

### 3.5 Configuration and migration (`~/.omp`, not in the fork)

Performed only after the forked `omp` passes the smoke test in 4.2.

**`~/.omp/agent/config.yml`**

- Add alias roles, no effort suffix:
  `sonnet: anthropic/claude-sonnet-5-5`, `opus: anthropic/claude-opus-5-5`, `fable: anthropic/claude-fable-5-1`, `sol: openai-codex/gpt-6-sol`, `astra: openai-codex/gpt-6-astra`, `luna: openai-codex/gpt-6-luna`, `terra: openai-codex/gpt-5.6-terra`, `glm: zai/glm-5.3`, `glm-flash: zai/glm-5.3-flash`.
- Add `task.spawnModelAliases: [sonnet, opus, fable, sol, astra, luna, terra, glm, glm-flash]`.
- Remove roles `anthropic-low`, `anthropic-medium`, `anthropic-high`, `anthropic-max`, `openai-low`, `openai-medium`, `openai-high`, `openai-max`, `zai-low`, `zai-medium`, `zai-high`.
- All other roles unchanged.

**`~/.omp/agent/agents/`**: delete the 11 stub files of the same names.

**`~/.omp/agent/skills/adversarial-review/SKILL.md`**

- §1 and §2 (platform identification and platform rule): unchanged in substance.
- §3 Roles → platform-to-alias table: anthropic = `sonnet`, `opus`, `fable`; openai = `sol`, `astra`, `luna`, `terra`; zai = `glm`, `glm-flash`.
- Tiers are replaced by alias + effort. The max rule becomes: never choose `fable`, `astra`, or `:max` effort unless the human asked for it in this conversation.
- §2 unavailable-model exception restated in aliases: first another allowed platform's comparable alias, then remaining allowed aliases, then excluded platforms, own vendor last.
- §5 Dispatch: `agent: "reviewer"` (or the agent the calling brief specifies) plus `model: "@alias[:effort]"`, instead of `agent: "<role>"`.
- §6: "Reviewed by `<alias>:<effort>` (`<resolved model>`)".

### 3.6 Fork maintenance

- Remotes: `upstream` = `can1357/oh-my-pi`; `origin` = the user's GitHub fork (created during implementation).
- The global `omp` runs from the clone's `packages/coding-agent`, replacing the global bun install. Acceptance: `command -v omp` resolves into `~/code/oh-my-pi`, and `omp --version` reports the fork build. The mechanism (`bun link` vs wrapper script) follows the repo's own dev-install instructions.
- Upgrades: rebase `feat/spawn-model` onto the new upstream release tag and rerun the fork's tests. `docs/fork-notes.md` in the clone records the procedure and the touched surfaces (3.1 table, 3.2 settings, 3.3 prompt).

## 4. Verification

### 4.1 Tests (fork, existing suite conventions)

1. Spawn `model` beats `task.agentModelOverrides` and frontmatter `model`; the child keeps the agent's prompt and tools.
2. A suffix effort overrides the agent's `auto`; without a suffix the agent's `thinkingLevel` applies. A suffix above `task.maxEffort` is refused, and a suffix spawn whose model fails over via `retry.fallbackChains` never runs above `task.maxEffort`.
3. Each 3.4 condition fails preflight and no subprocess or agent id is created.
4. Eval `agent(model=)` and `workpool(model=)` resolve identically to `task`.
5. The rendered `model` section lists exactly `task.spawnModelAliases` with catalog efforts, and is byte-stable across turns within a session.
6. A `before_subagent_spawn` handler returning `model` still overrides an explicit spawn `model`.
7. With `task.spawnModel: false`, the field is absent from the `task` schema and description.

### 4.2 Smoke test (real forked `omp`, before 3.5)

1. `task` with `agent: "task", model: "@glm-flash:high"`; `agent: "reviewer", model: "@sonnet:high"`; eval `agent(..., model="@sol")`. Agent Hub shows each resolved model and level as requested.
2. `@solx` and `@glm:medium` are refused with the 3.4 messages; no child starts.
3. After 3.5: one `adversarial-review` run end to end with the rewritten skill.

## 5. Out of scope

- Autonomous vendor routing (policy B/C).
- Propagating the user's model wording to grandchildren; a subagent's own spawns get a model only if its parent writes one into the child's task text.
- Changes to `^` model mentions or coarse `effort`.
- Upstream PR (decided later).
