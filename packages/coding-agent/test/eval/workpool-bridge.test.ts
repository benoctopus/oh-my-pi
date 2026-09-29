import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import * as structuredSubagent from "../../src/task/structured-subagent";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function makeSession(): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

const opusModel = getBundledModel("anthropic", "claude-opus-4-7" as never) as Model;
const opusString = `${opusModel.provider}/${opusModel.id}`;

function makeSpawnModelSession(): ToolSession {
	const modelRegistry = new ModelRegistry(createInMemoryAuthStorage(), "/nonexistent/spawn-model-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([opusModel]);
	const base = makeSession();
	return {
		...base,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"task.spawnModelAliases": ["sonnet"],
			modelRoles: { sonnet: opusString },
		} as never),
		modelRegistry,
	};
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("rejects unknown pool names", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});

	it("workpool create forwards model to policy and every worker", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const policySpy = vi.spyOn(structuredSubagent, "resolveEffectiveSubagentPolicy");
		const dispatched = Promise.withResolvers<void>();
		const runSpy = vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () => {
			dispatched.resolve();
			throw new Error("stop");
		});
		const session = makeSpawnModelSession();

		const created = await runEvalWorkpool({ op: "create", agent: "scout", model: "@sonnet" }, { session });
		expect(policySpy.mock.calls[0]?.[0].spawnModel).toBe("@sonnet");
		await runEvalWorkpool({ op: "push", name: created.name, items: ["a"] }, { session });
		await dispatched.promise;
		expect(runSpy.mock.calls[0]?.[0].spawnModel).toBe("@sonnet");
	});

	it("workpool create rejects a bad model", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSpawnModelSession();

		await expect(runEvalWorkpool({ op: "create", agent: "scout", model: "@solx" }, { session })).rejects.toThrow(
			"Unknown model alias",
		);
		expect(WorkPoolRegistry.global().get("Main", "scout-pool")).toBeUndefined();
	});
});
