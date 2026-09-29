/**
 * Validation of the per-spawn `model` selector: `@<alias>[:<effort>]` or `provider/id[:<effort>]`.
 * Aliases are model-role names the operator opted in via `task.spawnModelAliases`.
 */
import type { Api, Effort, Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveConfiguredModelPatterns, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgTaskMaxEffort, cfgTaskSpawnModel, cfgTaskSpawnModelAliases } from "./settings";

const ALIAS_PREFIX = "@";

export class SpawnModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpawnModelError";
	}
}

export interface SpawnModelSelection {
	selector: string;
	/** Expanded model patterns; the spawn's own effort suffix, if any, is the only suffix. */
	patterns: string[];
	model: Model<Api>;
	/** The spawn selector's own effort suffix, if any. */
	effort?: Effort;
}

export interface SpawnModelContext {
	settings: Settings;
	modelRegistry: ModelRegistry | undefined;
	coarseEffort: TaskEffort | undefined;
}

export interface SpawnModelAliasGroup {
	aliases: string[];
	efforts: readonly Effort[];
}

/** Expand `@role` to its configured patterns, dropping any suffix the role value carries and applying `level`. */
function expandAliasPatterns(role: string, level: string | undefined, settings: Settings): string[] {
	const patterns = resolveConfiguredModelPatterns(`${ALIAS_PREFIX}${role}`, settings).map(
		pattern => splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base,
	);
	return level ? patterns.map(pattern => `${pattern}:${level}`) : patterns;
}

function resolveAliasModel(
	role: string,
	level: string | undefined,
	settings: Settings,
	modelRegistry: ModelRegistry,
): { patterns: string[]; model: Model<Api> } {
	const patterns = expandAliasPatterns(role, level, settings);
	const model = resolveModelOverride(patterns, modelRegistry, settings).model;
	if (!model) {
		throw new SpawnModelError(
			`Model alias "${ALIAS_PREFIX}${role}" resolves to no available model (${settings.getModelRole(role) ?? "unset"}).`,
		);
	}
	return { patterns, model };
}

export function resolveSpawnModel(selector: string, ctx: SpawnModelContext): SpawnModelSelection {
	const { settings, modelRegistry, coarseEffort } = ctx;
	if (!cfgTaskSpawnModel.get(settings)) {
		throw new SpawnModelError("Spawn model selection is disabled (task.spawnModel).");
	}
	if (!modelRegistry) throw new SpawnModelError("Spawn model selection needs a model registry.");

	const trimmed = selector.trim();
	const isAlias = trimmed.startsWith(ALIAS_PREFIX);
	const { base, level } = splitThinkingSuffix(
		trimmed,
		isAlias ? ALIAS_PREFIX.length : -1,
		MAX_THINKING_SUFFIX_OPTIONS,
	);

	let patterns: string[];
	let model: Model<Api>;
	if (isAlias) {
		const role = base.slice(ALIAS_PREFIX.length);
		const aliases = cfgTaskSpawnModelAliases.get(settings);
		if (!aliases.includes(role)) {
			throw new SpawnModelError(
				`Unknown model alias "${base}". Available: ${aliases.map(alias => `${ALIAS_PREFIX}${alias}`).join(", ")}`,
			);
		}
		({ patterns, model } = resolveAliasModel(role, level, settings, modelRegistry));
	} else {
		const found = modelRegistry.getAvailable().find(candidate => formatModelString(candidate) === base);
		if (!found) throw new SpawnModelError(`Unknown model "${base}".`);
		model = found;
		patterns = [trimmed];
	}

	let effort: Effort | undefined;
	if (level) {
		const supported = getSupportedEfforts(model);
		if (!(THINKING_EFFORTS as readonly string[]).includes(level) || !supported.includes(level as Effort)) {
			throw new SpawnModelError(
				`${model.id} does not support effort "${level}". Supported: ${supported.join(", ")}.`,
			);
		}
		effort = level as Effort;
		if (coarseEffort !== undefined) {
			throw new SpawnModelError('Set effort either as a model suffix or via "effort", not both.');
		}
		const maxEffort = cfgTaskMaxEffort.get(settings);
		if (THINKING_EFFORTS.indexOf(effort) > THINKING_EFFORTS.indexOf(maxEffort)) {
			throw new SpawnModelError(`Effort "${effort}" exceeds task.maxEffort ("${maxEffort}").`);
		}
	}
	return { selector: trimmed, patterns, model, effort };
}

/** Listed aliases that resolve to an available model, grouped by identical effort set in first-seen order. */
export function buildSpawnModelAliasGroups(
	settings: Settings,
	modelRegistry: ModelRegistry | undefined,
): SpawnModelAliasGroup[] {
	if (!modelRegistry) return [];
	const groups = new Map<string, SpawnModelAliasGroup>();
	for (const alias of cfgTaskSpawnModelAliases.get(settings)) {
		let model: Model<Api>;
		try {
			model = resolveAliasModel(alias, undefined, settings, modelRegistry).model;
		} catch (error) {
			if (error instanceof SpawnModelError) continue;
			throw error;
		}
		const efforts = getSupportedEfforts(model);
		const key = efforts.join(",");
		const group = groups.get(key);
		if (group) group.aliases.push(alias);
		else groups.set(key, { aliases: [alias], efforts });
	}
	return [...groups.values()];
}

export function formatSpawnModelAliasTable(groups: SpawnModelAliasGroup[]): string {
	return groups
		.map(
			group =>
				`  ${group.aliases.map(alias => `${ALIAS_PREFIX}${alias}`).join(" ")}  efforts: ${group.efforts.join(" ")}`,
		)
		.join("\n");
}
