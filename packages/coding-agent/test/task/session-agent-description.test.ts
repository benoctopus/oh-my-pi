import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type AgentDefinition, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskSpawnModelAliases } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const DISCOVERED: AgentDefinition[] = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	},
];

function tagged(name: string, selector: string): AgentDefinition {
	return {
		name,
		description: `Pinned to ${selector}.`,
		systemPrompt: "You are a task agent.",
		model: [selector],
		source: "bundled",
	};
}

function createSession(
	sessionAgents: () => AgentDefinition[],
	advertisedSessionAgents?: () => AgentDefinition[],
	extras: { settings?: Settings; advertisedSpawnModelAliasTable?: () => string } = {},
): ToolSession {
	return {
		cwd: "/tmp/omp-session-agent-description",
		hasUI: false,
		settings: extras.settings ?? Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: sessionAgents,
		advertisedSessionAgents,
		advertisedSpawnModelAliasTable: extras.advertisedSpawnModelAliasTable,
	} as unknown as ToolSession;
}

describe("task description spawn model aliases", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const TABLE = "- @fast: efforts low, high\n- @deep: efforts medium";

	it("lists the advertised alias table when spawn model is enabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const tool = await TaskTool.create(
			createSession(() => [], undefined, { advertisedSpawnModelAliasTable: () => TABLE }),
		);
		expect(tool.description).toContain(
			'`model`: optional "@alias[:effort]". Set ONLY when the user names a model for this spawn.\n' +
				'Map the user\'s wording ("glm flash", "gpt sol", "Sonnet", "high effort") to an alias and literal effort.\n' +
				"Unlisted or ambiguous model, or an effort the model lacks: ask the user; never guess.\n" +
				TABLE,
		);
	});

	it("uses the advertised table, not live settings", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const settings = Settings.isolated();
		const tool = await TaskTool.create(
			createSession(() => [], undefined, { settings, advertisedSpawnModelAliasTable: () => TABLE }),
		);
		const first = tool.description;
		cfgTaskSpawnModelAliases.override(settings, ["other"]);
		expect(tool.description).toBe(first);
		expect(tool.description).toContain(TABLE);
	});

	it("omits the model section when task.spawnModel is false", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const settings = Settings.isolated({ "task.spawnModel": false });
		const tool = await TaskTool.create(
			createSession(() => [], undefined, { settings, advertisedSpawnModelAliasTable: () => TABLE }),
		);
		expect(tool.description).not.toContain("`model`:");
		expect(tool.description).not.toContain(TABLE);
	});
});

describe("task description session agents", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the frozen surface and stays byte-identical when a later tag lands", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const committed = [tagged("m1", "b/y")];
		const live = [tagged("m1", "b/y")];
		const tool = await TaskTool.create(
			createSession(
				() => live,
				() => committed,
			),
		);
		expect(tool.description).toContain("`m1`");
		expect(tool.description).toContain("b/y");

		// A mid-session `^c/w` registration only reaches the live set. The
		// model-facing description must not change: it is part of the provider tool
		// prefix, and mutating it would drop the prompt cache for the whole turn.
		const frozen = tool.description;
		live.push(tagged("m2", "c/w"));
		expect(tool.description).toBe(frozen);
		expect(tool.description).not.toContain("m2");
	});

	it("falls back to the live set when the embedder has no prompt surface", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const live: AgentDefinition[] = [];
		const tool = await TaskTool.create(createSession(() => live));
		expect(tool.description).not.toContain("`m1`");

		live.push(tagged("m1", "b/y"));
		expect(tool.description).toContain("`m1`");
	});
});
