import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildSpawnModelAliasGroups,
	formatSpawnModelAliasTable,
	resolveSpawnModel,
	SpawnModelError,
} from "@oh-my-pi/pi-coding-agent/task/spawn-model";
import type { TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function bundled(provider: "anthropic" | "openai-codex", id: string): Model {
	const model = getBundledModel(provider, id as never);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
	return model as Model;
}

// Bundled Sonnet 4.6 tops out at "high"; Opus 4.7 exposes the full low…max ladder the spec needs.
const sonnetModel = bundled("anthropic", "claude-opus-4-7");
const solModel = bundled("openai-codex", "gpt-5.6-sol");
const glmModel = buildModel({
	id: "glm-5.3",
	name: "GLM 5.3",
	api: "openai-completions",
	provider: "zai",
	baseUrl: "https://example.com",
	reasoning: true,
	thinking: { mode: "anthropic-budget-effort", efforts: ["low", "high", "max"] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
}) as Model;

const sonnetString = `${sonnetModel.provider}/${sonnetModel.id}`;
const solString = `${solModel.provider}/${solModel.id}`;
const glmString = "zai/glm-5.3";

function createRegistry(models: Model[]): ModelRegistry {
	const registry = new ModelRegistry(createInMemoryAuthStorage(), "/nonexistent/spawn-model-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

function fixture(overrides: Record<string, unknown> = {}, roles: Record<string, string> = {}) {
	const settings = Settings.isolated({
		"task.spawnModelAliases": ["sonnet", "glm", "sol"],
		modelRoles: { sonnet: sonnetString, glm: glmString, sol: solString, ...roles },
		...overrides,
	} as never);
	return { settings, modelRegistry: createRegistry([sonnetModel, glmModel, solModel]) };
}

function ctx(f: ReturnType<typeof fixture>, coarseEffort?: TaskEffort) {
	return { settings: f.settings, modelRegistry: f.modelRegistry as ModelRegistry | undefined, coarseEffort };
}

describe("resolveSpawnModel", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('resolves "@sonnet:high" to the sonnet model with effort high', () => {
		const result = resolveSpawnModel("@sonnet:high", ctx(fixture()));
		expect(result.model.id).toBe(sonnetModel.id);
		expect(result.effort).toBe("high");
		expect(result.patterns[0]).toBe(`${sonnetString}:high`);
	});

	it("resolves a max suffix", () => {
		expect(resolveSpawnModel("@sonnet:max", ctx(fixture())).effort).toBe("max");
	});

	it('resolves "@sonnet" without effort', () => {
		const result = resolveSpawnModel("@sonnet", ctx(fixture()));
		expect(result.model.id).toBe(sonnetModel.id);
		expect(result.effort).toBeUndefined();
	});

	it("lets the spawn suffix beat a suffixed role value", () => {
		const result = resolveSpawnModel("@sol:low", ctx(fixture({}, { sol: `${solString}:high` })));
		expect(result.effort).toBe("low");
		expect(result.patterns[0]).toBe(`${solString}:low`);
	});

	it("resolves an exact concrete selector", () => {
		const result = resolveSpawnModel(`${sonnetString}:medium`, ctx(fixture()));
		expect(result.model.id).toBe(sonnetModel.id);
		expect(result.effort).toBe("medium");
		expect(result.patterns).toEqual([`${sonnetString}:medium`]);
	});

	const unknownAlias = 'Unknown model alias "@%s". Available: @sonnet, @glm, @sol';
	it.each([
		["@solx", {}, {}, undefined, unknownAlias.replace("%s", "solx")],
		["@Sonnet", {}, {}, undefined, unknownAlias.replace("%s", "Sonnet")],
		["@commit", {}, { commit: sonnetString }, undefined, unknownAlias.replace("%s", "commit")],
		[
			"@sol",
			{},
			{ sol: "openai-codex/not-a-model" },
			undefined,
			'Model alias "@sol" resolves to no available model (openai-codex/not-a-model).',
		],
		["openai-codex/gpt-6-so", {}, {}, undefined, 'Unknown model "openai-codex/gpt-6-so".'],
		["@glm:medium", {}, {}, undefined, 'glm-5.3 does not support effort "medium". Supported: low, high, max.'],
		["@sonnet:high", {}, {}, "hi", 'Set effort either as a model suffix or via "effort", not both.'],
		["@sonnet:max", { "task.maxEffort": "high" }, {}, undefined, 'Effort "max" exceeds task.maxEffort ("high").'],
		["@sonnet", { "task.spawnModel": false }, {}, undefined, "Spawn model selection is disabled (task.spawnModel)."],
	] as [string, Record<string, unknown>, Record<string, string>, TaskEffort | undefined, string][])(
		"rejects %s",
		(selector, overrides, roles, coarse, message) => {
			const run = () => resolveSpawnModel(selector, ctx(fixture(overrides, roles), coarse));
			expect(run).toThrow(SpawnModelError);
			expect(run).toThrow(message);
		},
	);

	it("rejects a missing registry", () => {
		const run = () => resolveSpawnModel("@sonnet", { ...ctx(fixture()), modelRegistry: undefined });
		expect(run).toThrow(SpawnModelError);
		expect(run).toThrow("Spawn model selection needs a model registry.");
	});
});

describe("spawn model alias groups", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("groups aliases by effort set in configured order and omits unresolvable ones", () => {
		const f = fixture({ "task.spawnModelAliases": ["sonnet", "glm", "sol", "ghost"] });
		expect(buildSpawnModelAliasGroups(f.settings, f.modelRegistry)).toEqual([
			{ aliases: ["sonnet", "sol"], efforts: ["low", "medium", "high", "xhigh", "max"] },
			{ aliases: ["glm"], efforts: ["low", "high", "max"] },
		]);
	});

	it("formats the alias table", () => {
		expect(
			formatSpawnModelAliasTable([
				{ aliases: ["sonnet", "sol"], efforts: ["low", "medium", "high", "xhigh", "max"] as never },
				{ aliases: ["glm"], efforts: ["low", "high", "max"] as never },
			]),
		).toBe("  @sonnet @sol  efforts: low medium high xhigh max\n  @glm  efforts: low high max");
	});
});
