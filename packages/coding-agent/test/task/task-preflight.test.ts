import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as structuredModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: {
	manager: AsyncJobManager;
	settings?: Record<string, unknown>;
	spawns?: string | boolean;
	cwd?: string;
	modelRegistry?: ModelRegistry;
}): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, ...options.settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
		modelRegistry: options.modelRegistry,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task async preflight", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	it.each([
		{
			name: "Unknown",
			params: { agent: "missing", name: "Unknown", task: "Work." },
			expectation: 'Unknown agent "missing"',
		},
		{
			name: "Disabled",
			params: { agent: "task", name: "Disabled", task: "Work." },
			settings: { "task.disabledAgents": ["task"] },
			expectation: 'Agent "task" is disabled',
		},
		{
			name: "Disallowed",
			params: { agent: "task", name: "Disallowed", task: "Work." },
			spawns: "scout",
			expectation: "Cannot spawn 'task'",
		},
	])(
		"returns $name policy errors before registering an async job",
		async ({ name, params, settings, spawns, expectation }) => {
			mockDiscovery();
			const jobs = manager();
			const tool = await TaskTool.create(createSession({ manager: jobs, settings, spawns }));

			const result = await tool.execute("preflight", params as TaskParams);

			expect(textOf(result)).toContain(expectation);
			expect(jobs.getJob(name)).toBeUndefined();
		},
	);

	it("rejects an invalid async batch atomically before dispatching any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));

		const result = await tool.execute("mixed-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "AlsoInvalid", agent: "also-missing", task: "Do more invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		const text = textOf(result);
		expect(text).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(text).toContain('Task AlsoInvalid failed preflight: Unknown agent "also-missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("AlsoInvalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("rejects an invalid synchronous batch before running any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("sync-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		expect(textOf(result)).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("names the searched agent directories, home-shortened, when the agent is unknown", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unknown-agent-"));
		try {
			const projectDir = path.join(home, "project");
			await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
			vi.spyOn(os, "homedir").mockReturnValue(home);
			const tool = await TaskTool.create(createSession({ manager: manager(), cwd: projectDir }));

			const result = await tool.execute("unknown", {
				agent: "missing",
				name: "Unknown",
				task: "Work.",
			} as TaskParams);

			const text = textOf(result);
			expect(text).toContain(`Searched: ${path.join("~", "project", ".omp", "agents")}`);
			expect(text).not.toContain(home);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	describe("spawn model", () => {
		const opusModel = getBundledModel("anthropic", "claude-opus-4-7" as never) as Model;
		const opusString = `${opusModel.provider}/${opusModel.id}`;

		function modelSession(jobs: AsyncJobManager, settings?: Record<string, unknown>): ToolSession {
			const modelRegistry = new ModelRegistry(createInMemoryAuthStorage(), "/nonexistent/spawn-model-models.yml");
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([opusModel]);
			return createSession({
				manager: jobs,
				modelRegistry,
				settings: {
					"task.spawnModelAliases": ["sonnet"],
					modelRoles: { sonnet: opusString },
					...settings,
				},
			});
		}

		it("rejects an unknown spawn model before spawning", async () => {
			mockDiscovery();
			const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
			const jobs = manager();
			const register = vi.spyOn(jobs, "register");
			const tool = await TaskTool.create(modelSession(jobs, { "task.batch": true }));

			const result = await tool.execute("bad-model", {
				context: "Shared context.",
				tasks: [{ name: "Bad", agent: "task", task: "Work.", model: "@solx" }],
			} as TaskParams);

			expect(textOf(result)).toContain('Unknown model alias "@solx"');
			expect(runSubprocess).not.toHaveBeenCalled();
			expect(register).not.toHaveBeenCalled();
		});

		it("rejects the whole batch when one item has a bad model", async () => {
			mockDiscovery();
			const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
			const jobs = manager();
			const register = vi.spyOn(jobs, "register");
			const tool = await TaskTool.create(modelSession(jobs, { "task.batch": true }));

			const result = await tool.execute("bad-batch", {
				context: "Shared context.",
				tasks: [
					{ name: "Good", agent: "task", task: "Work.", model: "@sonnet" },
					{ name: "Bad", agent: "task", task: "Work.", model: "@glm:medium" },
				],
			} as TaskParams);

			expect(textOf(result)).toContain('Unknown model alias "@glm"');
			expect(runSubprocess).not.toHaveBeenCalled();
			expect(register).not.toHaveBeenCalled();
			expect(jobs.getJob("Good")).toBeUndefined();
		});

		it.each([
			{
				shape: "batch",
				settings: { "task.batch": true },
				params: {
					context: "Shared context.",
					tasks: [{ name: "Worker", agent: "task", task: "Work.", model: "@sonnet:high" }],
				},
			},
			{
				shape: "flat",
				settings: { "task.batch": false },
				params: { name: "Worker", agent: "task", task: "Work.", model: "@sonnet:high" },
			},
		])("forwards model to the structured request ($shape)", async ({ settings, params }) => {
			mockDiscovery();
			const run = vi.spyOn(structuredModule, "runStructuredSubagent").mockRejectedValue(new Error("stop"));
			const tool = await TaskTool.create(modelSession(manager(), { ...settings, "async.enabled": false }));

			await tool.execute("forward", params as TaskParams);

			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0][0].spawnModel).toBe("@sonnet:high");
		});
	});
});
