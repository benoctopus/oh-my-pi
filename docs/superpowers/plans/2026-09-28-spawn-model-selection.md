# Spawn-Level Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `task`, eval `agent()` and `workpool()` spawn any agent on a user-named `@alias[:effort]` or concrete selector, validated at preflight, with literal effort and no silent fallback.

**Architecture:** A new pure module `src/task/spawn-model.ts` validates the spawn selector and builds the alias table. `resolveEffectiveSubagentPolicy` calls it and feeds the validated patterns into the existing `requestModel` slot. The executor gets a flag that disables parent-auth fallback and arms the `task.maxEffort` ceiling for suffix efforts. Surfaces (`task` schema, eval preludes and bridges) forward a new `spawnModel` request field. The alias table is frozen into the session prompt surface like user-tagged model agents.

**Tech Stack:** TypeScript on Bun (`bun:test`, `arktype` schemas), Handlebars prompt templates, Python and JS eval preludes.

**Spec:** `docs/superpowers/specs/2026-09-28-spawn-model-selection-design.md`

## Global Constraints

- Base: tag `v18.4.2`, branch `feat/spawn-model`, repo `~/code/oh-my-pi`. All `src/`/`test/` paths are under `packages/coding-agent/`.
- The user-facing field is named `model` on every surface; the internal request field is `StructuredSubagentRequest.spawnModel`. `StructuredSubagentRequest.model` is untouched (used by `src/cleanse/agent.ts`).
- Settings: `task.spawnModel` (boolean, default `true`), `task.spawnModelAliases` (string[], default `[]`).
- Value: one string; `@<alias>[:<effort>]` or `provider/id[:<effort>]`. Arrays and empty strings are schema errors.
- Error messages are exactly the spec 3.4 table strings (templated values in `<>`):
  - `Unknown model alias "@<alias>". Available: @a, @b, …` (all `task.spawnModelAliases`, comma-space joined, `@`-prefixed)
  - `Model alias "@<alias>" resolves to no available model (<role value or "unset">).`
  - `Unknown model "<selector without suffix>".`
  - `<model.id> does not support effort "<level>". Supported: <efforts comma-space joined>.`
  - `Set effort either as a model suffix or via "effort", not both.`
  - `Effort "<level>" exceeds task.maxEffort ("<maxEffort>").`
  - `Spawn model selection is disabled (task.spawnModel).`
  - `Spawn model selection needs a model registry.`
- All errors are preflight errors: `StructuredSubagentError` with kind `"preflight"`; no agent id, artifact lease, or subprocess.
- Tests: `bun test <file>` from `packages/coding-agent`. Before each commit: `bun run check:tools` from repo root must pass for touched files.
- Commit messages: conventional commits (`feat(task): …`, `docs: …`).

## Review Focus

1. `@opus:max` must parse as alias `opus` + effort `max` (the `:max` suffix needs `MAX_THINKING_SUFFIX_OPTIONS`), not as unknown alias `opus:max`. Test in Task 1.
2. A concrete selector typo (`openai-codex/gpt-6-so`) must fail with `Unknown model`, never fuzzy-match another model. Test in Task 1.
3. One bad `model` in a `tasks[]` batch rejects the whole batch before any spawn, like other preflight errors. Test in Task 4.
4. A role whose value already carries a suffix (`sol: openai-codex/gpt-6-sol:high`) spawned as `@sol:low` runs at `low`: the spawn suffix wins. Test in Task 1.
5. Alias matching is exact and case-sensitive after trimming whitespace: `@Sonnet` is unknown and lists the aliases. Test in Task 1.

---

### Task 1: Settings and spawn-model validator

**Files:**
- Modify: `src/task/settings.ts` (next to `cfgTaskEnableEffort` / `cfgTaskMaxEffort`; array shape mirrors `cfgTaskDisabledAgents`)
- Create: `src/task/spawn-model.ts`
- Test: `test/task/spawn-model.test.ts`

**Interfaces:**
- Produces:
  - `cfgTaskSpawnModel` (`task.spawnModel`, boolean, default `true`, ui tab `"tasks"`, group `"Subagents"`)
  - `cfgTaskSpawnModelAliases` (`task.spawnModelAliases`, string[], default `[]`, same ui group)
  - `class SpawnModelError extends Error`
  - `interface SpawnModelSelection { selector: string; patterns: string[]; model: Model; effort?: Effort }` (`patterns` = the expanded `resolveConfiguredModelPatterns(selector, settings)` output; `effort` = the spawn selector's own suffix, if any)
  - `interface SpawnModelContext { settings: Settings; modelRegistry: ModelRegistry | undefined; coarseEffort: TaskEffort | undefined }`
  - `function resolveSpawnModel(selector: string, ctx: SpawnModelContext): SpawnModelSelection` (throws `SpawnModelError`)
  - `interface SpawnModelAliasGroup { aliases: string[]; efforts: readonly Effort[] }`
  - `function buildSpawnModelAliasGroups(settings: Settings, modelRegistry: ModelRegistry | undefined): SpawnModelAliasGroup[]`
  - `function formatSpawnModelAliasTable(groups: SpawnModelAliasGroup[]): string`

- [ ] **Step 1: Write the failing tests** in `test/task/spawn-model.test.ts`. Use `Settings.isolated({ "task.spawnModelAliases": ["sonnet", "glm", "sol"], modelRoles: {...} })` and a registry built like `test/auto-thinking-classifier.test.ts:193` (`createRegistry`). Models: a bundled Anthropic model for `sonnet` (efforts `low…max`); a mock `zai/glm-5.3` with `reasoning: true`, `thinking: { mode: "anthropic-budget-effort", efforts: ["low","high","max"] }`; a bundled `openai-codex/gpt-5.6-sol` for `sol`.
  - `resolves "@sonnet:high" to the sonnet model with effort high` → `model.id` matches, `effort === "high"`, `patterns[0]` ends with `:high`.
  - `resolves "@opus:max"-style max suffix` (use `@sonnet:max`) → `effort === "max"`.
  - `resolves "@sonnet" without effort` → `effort` undefined.
  - `spawn suffix beats a suffixed role value` → role `sol: "<sol selector>:high"`, selector `@sol:low` → `effort === "low"`, `patterns[0]` ends with `:low`.
  - `resolves an exact concrete selector` → `"anthropic/<sonnet id>:medium"` → `effort === "medium"`.
  - `it.each` of error cases, each asserting `toThrow(SpawnModelError)` with the exact Global Constraints message:
    - `@solx` → `Unknown model alias "@solx". Available: @sonnet, @glm, @sol`
    - `@Sonnet` → same `Unknown model alias` shape
    - `@commit` with `modelRoles.commit` set but not listed → `Unknown model alias "@commit". …`
    - listed alias `sol` whose role value is not in the registry → `Model alias "@sol" resolves to no available model (<value>).`
    - `openai-codex/gpt-6-so` → `Unknown model "openai-codex/gpt-6-so".`
    - `@glm:medium` → `glm-5.3 does not support effort "medium". Supported: low, high, max.`
    - `@sonnet:high` with `coarseEffort: "hi"` → `Set effort either as a model suffix or via "effort", not both.`
    - `@sonnet:max` with `task.maxEffort: "high"` → `Effort "max" exceeds task.maxEffort ("high").`
    - `@sonnet` with `task.spawnModel: false` → `Spawn model selection is disabled (task.spawnModel).`
    - `@sonnet` with `modelRegistry: undefined` → `Spawn model selection needs a model registry.`
  - `buildSpawnModelAliasGroups groups aliases by effort set in configured order` → `[{ aliases: ["sonnet","sol"], efforts: [low,medium,high,xhigh,max] }, { aliases: ["glm"], efforts: [low,high,max] }]`; an alias whose role doesn't resolve is omitted.
  - `formatSpawnModelAliasTable` → exactly `"  @sonnet @sol  efforts: low medium high xhigh max\n  @glm  efforts: low high max"`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/task/spawn-model.test.ts`
Expected: FAIL (module `src/task/spawn-model.ts` not found).

- [ ] **Step 3: Register both settings in `src/task/settings.ts`, and implement `src/task/spawn-model.ts`.**
  Order of checks in `resolveSpawnModel`: disabled gate → registry present → trim → split suffix with `splitThinkingSuffix(trimmed, <alias prefix length or -1>, MAX_THINKING_SUFFIX_OPTIONS)` (import as `model-resolver.ts` does) → if base starts with `@`: role = base without `@`; must be in `cfgTaskSpawnModelAliases` (exact) → `patterns = resolveConfiguredModelPatterns(trimmed, settings)`; resolve with `resolveModelOverride(patterns, modelRegistry, settings)`; missing model → alias-unavailable error using `settings.getModelRole(role) ?? "unset"`. Else (concrete): `modelRegistry.getAvailable().find(m => formatModelString(m) === base)`; missing → `Unknown model`. `patterns = [trimmed]`. Then, if a suffix level exists: it must be in `THINKING_EFFORTS`, and in `getSupportedEfforts(model)` (else the unsupported-effort error, which also covers non-effort suffixes such as `auto`). `coarseEffort` set → both-set error. Index above `cfgTaskMaxEffort` in `THINKING_EFFORTS` → exceeds error. `buildSpawnModelAliasGroups` resolves each listed alias the same way (skips failures) and groups by the joined effort list in first-seen order.
  Role values may already carry a suffix (Review Focus 4). `resolveConfiguredModelPatterns` appends the spawn suffix to each expanded pattern, and may yield `…:high:low`. If it does, build `patterns` from the role's expansion with its suffix stripped, then append the spawn suffix, so `patterns[0]` ends in exactly one `:<effort>`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/task/spawn-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task/settings.ts src/task/spawn-model.ts test/task/spawn-model.test.ts
git commit -m "feat(task): spawn model selector validation and settings"
```

### Task 2: Policy integration

**Files:**
- Modify: `src/task/structured-subagent.ts` (`StructuredSubagentRequest`, `EffectiveSubagentPolicy`, `resolveEffectiveSubagentPolicy`, `applySpawnHook`, `buildExecutorOptions`)
- Modify: `src/task/executor.ts` (`ExecutorOptions` type only; behaviour in Task 3)
- Test: `test/task/structured-subagent.test.ts`

**Interfaces:**
- Consumes: `resolveSpawnModel`, `SpawnModelError`, `SpawnModelSelection` (Task 1).
- Produces:
  - `StructuredSubagentRequest.spawnModel?: string`
  - `EffectiveSubagentPolicy.spawnModel?: SpawnModelSelection`
  - `ExecutorOptions.spawnModel?: { effortSuffix: boolean }` (present only when the policy has a spawn model the hook did not replace)

- [ ] **Step 1: Write the failing tests** in `test/task/structured-subagent.test.ts`, using the file's fake session + `request()` factory (:40-101) with a `modelRegistry` added to the fake session and the same settings shape as Task 1:
  - `spawn model beats agentModelOverrides and frontmatter model` → with `cfgTaskAgentModelOverrides` set for the agent and frontmatter `model`, `resolveEffectiveSubagentPolicy(request({ spawnModel: "@sonnet:high" }))` gives `modelOverride` equal to the Task 1 patterns; `effectiveAgent.systemPrompt` and `tools` equal the discovered agent's.
  - `invalid spawn model fails preflight without running` → `runStructuredSubagent(request({ spawnModel: "@solx" }))` rejects with `StructuredSubagentError` kind `"preflight"` and the Task 1 message; `runSubprocess` spy not called; `artifactsDirsFromRegistry()` empty (mirror :498-506).
  - `executor receives spawnModel flag` → the dispatched `ExecutorOptions.spawnModel` equals `{ effortSuffix: true }` for `@sonnet:high`, `{ effortSuffix: false }` for `@sonnet`, and is undefined without `spawnModel`.
  - `before_subagent_spawn still replaces an explicit spawn model` → extend the pattern at :450-486: the hook returns `{ model: "openai/gpt-4o" }` → dispatched `modelOverride` is the hook's, and `ExecutorOptions.spawnModel` is undefined.
  - `internal request.model stays unvalidated` → `request({ model: "some/unknown-model" })` does not throw at preflight (cleanse path unchanged).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/task/structured-subagent.test.ts`
Expected: the new tests FAIL; the existing ones pass.

- [ ] **Step 3: Implement.** In `resolveEffectiveSubagentPolicy`, after `reloadFromDisk()` and agent lookup, before `resolveAgentModelSelection`: if `request.spawnModel !== undefined`, call `resolveSpawnModel(request.spawnModel, { settings, modelRegistry: request.session.modelRegistry, coarseEffort: request.effort })`, rethrow `SpawnModelError` as `new StructuredSubagentError("preflight", err.message)`, and pass `requestModel: selection.patterns` (else `request.model` as today). Store `spawnModel: selection` on the policy. In `applySpawnHook`'s replacement branch, return the policy with `spawnModel: undefined`. In `buildExecutorOptions`, set `spawnModel: policy.spawnModel ? { effortSuffix: policy.spawnModel.effort !== undefined } : undefined`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/task/structured-subagent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task/structured-subagent.ts src/task/executor.ts test/task/structured-subagent.test.ts
git commit -m "feat(task): resolve spawn model in subagent policy"
```

### Task 3: Executor — no auth fallback, effort ceiling for suffix

**Files:**
- Modify: `src/task/executor.ts` (`runSubprocess`: the `resolveModelOverrideWithAuthFallback` call ~:3738, `spawnEffortCeiling` :3805, `modelPatternAuthFallback` :3939)
- Test: `test/task/executor-pass-through.test.ts`

**Interfaces:**
- Consumes: `ExecutorOptions.spawnModel` (Task 2).

- [ ] **Step 1: Write the failing tests** next to `caps caller-requested effort at task.maxEffort` (:398), same harness (`createAgentSession` spy):
  - `arms task.maxEffort ceiling for a spawn model effort suffix` → `Settings.isolated({ "task.maxEffort": "high" })`, run with `modelOverride: ["<sol selector>:high"]`, `spawnModel: { effortSuffix: true }` → `spy.mock.calls[0][0].thinkingLevelCeiling === Effort.High` and `thinkingLevel === Effort.High`.
  - `does not arm the ceiling for a spawn model without suffix` → `spawnModel: { effortSuffix: false }` → `thinkingLevelCeiling` undefined.
  - `explicit spawn model never falls back to the parent model` → mirror `test/issue-985-subagent-auth-fallback.test.ts` setup (primary lacks auth, `parentActiveModelPattern` authed), with `spawnModel: { effortSuffix: false }` → result fails (non-zero `exitCode`, `createAgentSession` not called with the parent model); without `spawnModel` the existing fallback still happens (the existing test covers that).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/task/executor-pass-through.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** When `options.spawnModel` is set: pass `undefined` as `parentActiveModelPattern` to `resolveModelOverrideWithAuthFallback` and as `modelPatternAuthFallback`. `spawnEffortCeiling = options.effort !== undefined || options.spawnModel?.effortSuffix ? cfgTaskMaxEffort.get(settings) : undefined`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/task/executor-pass-through.test.ts test/issue-985-subagent-auth-fallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task/executor.ts test/task/executor-pass-through.test.ts
git commit -m "feat(task): enforce effort ceiling and no auth fallback for spawn model"
```

### Task 4: `task` tool surface

**Files:**
- Modify: `src/task/types.ts` (`createTaskSchema`, `getTaskSchema` + its cache key)
- Modify: `src/task/index.ts` (`resolveSpawnItems`, `spawnParamsFor`, `#resolveSpawnPreflight`, `#runSpawn`, `get parameters`)
- Modify: `TaskParams` / item types wherever `effort` is declared for task params (follow `effort` with `xd://lsp` references)
- Test: `test/task/task-schema.test.ts`, `test/task/task-preflight.test.ts`

**Interfaces:**
- Consumes: `cfgTaskSpawnModel` (Task 1), `StructuredSubagentRequest.spawnModel` (Task 2).
- Produces: `getTaskSchema({ …, spawnModelEnabled: boolean })`; `TaskParams.model?: string` and per-item `model?: string`.

- [ ] **Step 1: Write the failing tests.**
  - `task-schema.test.ts`: `model field present only when spawnModelEnabled` → batch-item and flat schemas accept `{ model: "@sonnet" }` when enabled; when disabled, the schema has no `model` key (mirror the existing `effortEnabled` test); `model: ""` and `model: ["@a"]` are rejected when enabled.
  - `task-preflight.test.ts` (mirror the `it.each` at :94-142):
    - `rejects an unknown spawn model before spawning` → one item with `model: "@solx"`; tool result is an error containing `Unknown model alias "@solx"`; `runSubprocess` and `jobs.register` not called.
    - `rejects the whole batch when one item has a bad model` → two items, the second `model: "@glm:medium"`; neither spawns.
    - `forwards model to the structured request` → spy `runStructuredSubagent`; a valid item with `model: "@sonnet:high"` produces a request with `spawnModel: "@sonnet:high"` (flat shape too).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/task/task-schema.test.ts test/task/task-preflight.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Mirror each `effort` hop: `"model?": "string>0"` via a `spawnModelField` spread gated by `spawnModelEnabled` (cache key gains `:${spawnModelEnabled ? "model" : "nomodel"}`); `get parameters` passes `spawnModelEnabled: cfgTaskSpawnModel.get(settings)`; the flat→item copy (`if ("model" in params) item.model = params.model`), item→spawn copy, and both request builders spread `spawnModel: params.model` when defined.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/task/task-schema.test.ts test/task/task-preflight.test.ts test/task/task-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task/types.ts src/task/index.ts test/task/task-schema.test.ts test/task/task-preflight.test.ts
git commit -m "feat(task): model field on task spawns"
```

### Task 5: Eval `agent()` and `workpool()` surfaces

**Files:**
- Modify: `src/eval/agent-bridge.ts` (`agentArgsSchema`, `EvalAgentArgs`, both request builders :194-226)
- Modify: `src/eval/workpool-bridge.ts` (create op :71-105)
- Modify: `src/task/workpool.ts` (`WorkPoolCreateOptions`, first-turn `runStructuredSubagent` :380)
- Modify: `src/eval/py/prelude.py` (`agent()` :993, `workpool()` :1068)
- Modify: `src/eval/js/shared/prelude.txt` (`agent` whitelist :440-441, `workpool` whitelist :504-505)
- Modify: `src/prompts/tools/eval-agents.md` (signature lines)
- Test: `test/eval/agent-bridge-policy.test.ts`, `test/eval/workpool-bridge.test.ts`

**Interfaces:**
- Consumes: `StructuredSubagentRequest.spawnModel` (Task 2).
- Produces: Python `agent(prompt, *, …, model=None)`, `workpool(agent=None, *, name=None, context=None, tools=None, model=None)`; JS option key `model` on both; bridge arg `model?: string`; `WorkPoolCreateOptions.spawnModel?: string`.

- [ ] **Step 1: Write the failing tests.**
  - `agent-bridge-policy.test.ts` (near the model precedent at :347-356): `agent() forwards model as spawnModel` → `runEvalAgent({ prompt: "x", model: "@sonnet:high" }, …)` produces preflight and run requests with `spawnModel: "@sonnet:high"`; `agent() rejects a bad model at preflight` → `model: "@solx"` throws `ToolError` containing `Unknown model alias`, and no job is registered.
  - `workpool-bridge.test.ts` (mirror :48-90): `workpool create forwards model to policy and every worker` → `create` with `model: "@sonnet"`; the `resolveEffectiveSubagentPolicy` spy sees `spawnModel: "@sonnet"`; pushing an item makes the first-turn `runStructuredSubagent` request carry `spawnModel: "@sonnet"`. `workpool create rejects a bad model` → no pool registered.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/eval/agent-bridge-policy.test.ts test/eval/workpool-bridge.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Add `"model?": "string>0"` to `agentArgsSchema`, and forward it as `spawnModel` in both builders. In the workpool create op, read `optionalString(record, "model")`, pass it as `spawnModel` to preflight, and store it on `WorkPoolCreateOptions`. The first-turn dispatch spreads `spawnModel`; follow-up turns reuse the live session and need nothing. Preludes: add the `model` parameter and forward it as `args["model"]`; add `model` to both JS whitelists and usage strings. In `eval-agents.md`, add `model?=None` to both signatures, plus: "`model`: `@alias[:effort]` exactly as the `task` tool's `model` field; set only when the user names a model."

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/eval/agent-bridge-policy.test.ts test/eval/workpool-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval src/task/workpool.ts src/prompts/tools/eval-agents.md test/eval
git commit -m "feat(eval): model option for agent() and workpool()"
```

### Task 6: Frozen alias table in the task description

**Files:**
- Modify: `src/session/session-tools.ts` (`SessionToolsHost` :89, `PromptSurface` :259-266, `#derivePromptSurface` :538, new getter next to `advertisedSessionAgents` :533)
- Modify: `src/session/agent-session.ts` (host wiring next to `sessionAgents: () => this.getSessionAgents()` ~:1829; getter next to `getAdvertisedSessionAgents` :6049)
- Modify: `src/sdk.ts` (next to `advertisedSessionAgents` :2230)
- Modify: `src/tools/index.ts` (`ToolSession`, next to `advertisedSessionAgents` :409)
- Modify: `src/task/index.ts` (`TaskDescriptionOptions`, `renderDescription`, `get description`)
- Modify: `src/prompts/tools/task.md` (after the `effortEnabled` line 16)
- Test: `test/task/session-agent-description.test.ts`

**Interfaces:**
- Consumes: `buildSpawnModelAliasGroups`, `formatSpawnModelAliasTable`, `cfgTaskSpawnModel` (Task 1).
- Produces: `SessionToolsHost.spawnModelAliasTable(): string`; `PromptSurface.spawnModelAliasTable: string`; `SessionTools.advertisedSpawnModelAliasTable: string`; `AgentSession.getAdvertisedSpawnModelAliasTable(): string`; `ToolSession.advertisedSpawnModelAliasTable?: () => string`.

- [ ] **Step 1: Write the failing tests** in `test/task/session-agent-description.test.ts` (reuse its `ToolSession` factory :27-38, adding `advertisedSpawnModelAliasTable` and settings):
  - `lists the advertised alias table when spawn model is enabled` → the description contains the exact spec 3.3 guidance lines and the table string passed in.
  - `uses the advertised table, not live settings` → change `task.spawnModelAliases` on the session settings after construction; the description still shows the advertised table (byte-equal across two reads).
  - `omits the model section when task.spawnModel is false` → the description contains no `` `model`: `` line.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/task/session-agent-description.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Mirror every `sessionAgents` / `advertisedSessionAgents` hop for `spawnModelAliasTable`. The host computes `formatSpawnModelAliasTable(buildSpawnModelAliasGroups(settings, modelRegistry))`. `renderDescription` receives `spawnModelEnabled` and `spawnModelAliasTable`. Template copy (exact; the table is inserted verbatim):

```
{{#if spawnModelEnabled}}`model`: optional "@alias[:effort]". Set ONLY when the user names a model for this spawn.
Map the user's wording ("glm flash", "gpt sol", "Sonnet", "high effort") to an alias and literal effort.
Unlisted or ambiguous model, or an effort the model lacks: ask the user; never guess.
{{spawnModelAliasTable}}
{{/if}}
```

  If `prompt.render` HTML-escapes `{{…}}`, use the template's existing raw-output form (check how other preformatted strings are rendered in `src/prompts/tools/*.md`).

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/task/session-agent-description.test.ts test/task/spawn-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session src/sdk.ts src/tools/index.ts src/task/index.ts src/prompts/tools/task.md test/task/session-agent-description.test.ts
git commit -m "feat(task): advertise spawn model aliases in task description"
```

### Task 7: Docs, changelog, fork notes; full suite

**Files:**
- Modify: `docs/task-agent-discovery.md` (model precedence list ~:214: insert the spawn `model` as item 0 above `task.agentModelOverrides`; add a "Spawn-level model" subsection after "Role-backed custom agents")
- Modify: `docs/tools/task.md` (inputs table: `model` row next to `effort` :42)
- Modify: `docs/settings.md` (rows for `task.spawnModel`, `task.spawnModelAliases`)
- Modify: `packages/coding-agent/CHANGELOG.md` (`## [Unreleased]` → `### Added` entry)
- Create: `docs/fork-notes.md` (remotes; rebase procedure `git fetch upstream --tags && git rebase <tag>`, then `bun setup` and the Step 2 commands; touched surfaces = spec 3.1 table, 3.2 settings, 3.3 prompt, plus `src/task/spawn-model.ts`)

- [ ] **Step 1: Write the docs.** Each doc states the precedence (`model` > `task.agentModelOverrides` > frontmatter > parent), the suffix-vs-`effort` rule, the `task.maxEffort` rule, and that the parent auth fallback is off.
- [ ] **Step 2: Full verification**

Run (repo root): `bun run check:ts && bun --cwd=packages/coding-agent test`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs packages/coding-agent/CHANGELOG.md
git commit -m "docs: spawn-level model selection"
```

### Task 8: Run the fork as the daily `omp`, and smoke test

**Files:** none in the repo; `~/.local/bin/omp` (wrapper).

- [ ] **Step 1: Create the GitHub fork and set `origin`**

Run (in `~/code/oh-my-pi`, whose only remote is `upstream`): `gh repo fork --remote --remote-name origin && git push -u origin feat/spawn-model`
Expected: the push succeeds.

- [ ] **Step 2: Build from source**

Run (repo root): `bun setup && bun dev -- --version`
Expected: prints the version.

- [ ] **Step 3: Swap the global `omp`.** `~/.bun/bin` precedes `~/.local/bin` on PATH, so remove the global package first: `bun remove -g @oh-my-pi/pi-coding-agent`. Then write `~/.local/bin/omp`:

```sh
#!/bin/sh
exec bun /Users/b/code/oh-my-pi/packages/coding-agent/src/cli.ts "$@"
```

`chmod +x ~/.local/bin/omp`.
Run: `command -v omp && omp --version`
Expected: `/Users/b/.local/bin/omp`, and the fork's version.

- [ ] **Step 4: Temporary aliases for the smoke test.** Add the nine alias roles and `task.spawnModelAliases` from spec 3.5 to `~/.omp/agent/config.yml`. Leave the old tier roles and stubs in place until Task 9.
- [ ] **Step 5: Smoke test (spec 4.2 steps 1–2)** in a fresh `omp` session:
  - `task` batch: `{agent:"task", model:"@glm-flash:high"}`, `{agent:"reviewer", model:"@sonnet:high"}`; eval `agent("…", model="@sol")`. In the Agent Hub (`Alt+A`) the rows show `zai/glm-5.3-flash:high`, `anthropic/claude-sonnet-5-5:high`, and `openai-codex/gpt-6-sol`.
  - `model:"@solx"` and `model:"@glm:medium"` return the Global Constraints messages; no row appears in the Agent Hub.
  - The `task` tool description in the session shows the alias table with two groups.

### Task 9: `~/.omp` migration and adversarial-review rewrite

**Files:** `~/.omp/agent/config.yml`, `~/.omp/agent/agents/*.md`, `~/.omp/agent/skills/adversarial-review/SKILL.md` (not in the repo; no git).

- [ ] **Step 1: Config.** Remove roles `anthropic-low`, `anthropic-medium`, `anthropic-high`, `anthropic-max`, `openai-low`, `openai-medium`, `openai-high`, `openai-max`, `zai-low`, `zai-medium`, `zai-high`. Keep the Task 8 aliases and `task.spawnModelAliases`.
- [ ] **Step 2: Delete the 11 stubs** in `~/.omp/agent/agents/` with the same names.
- [ ] **Step 3: Rewrite `SKILL.md`** per spec 3.5:
  - §3 becomes a platform→alias table: anthropic `sonnet` `opus` `fable`; openai `sol` `astra` `luna` `terra`; zai `glm` `glm-flash`.
  - The max rule: never `fable`, `astra`, or `:max` unless asked.
  - The §2 fallback order is in aliases.
  - §5 dispatches `agent: "reviewer"` (or the brief's agent) plus `model: "@alias[:effort]"`.
  - §6 reports "Reviewed by `<alias>:<effort>` (`<resolved model>`)".
  - Remove every reference to the old role names.
- [ ] **Step 4: Verify.**
  - `grep -rE "(anthropic|openai|zai)-(low|medium|high|max)" ~/.omp/agent/config.yml ~/.omp/agent/skills ~/.omp/agent/agents` prints nothing.
  - A new `omp` session lists no stub agents in the `task` description.
  - One adversarial-review run of this plan file ends with "Reviewed by `@sol…`" and the resolved model in the Agent Hub (spec 4.2 step 3).
