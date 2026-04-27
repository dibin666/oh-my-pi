import * as path from "node:path";
import { getAgentDir, getConfigDirName, getProjectDir } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { MCPServer } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import { ConfigFile } from "../config";
import type { MCPServerConfig } from "./types";
import { DEFAULT_MCP_TIMEOUT_MS } from "./types";

const TimeoutValueSchema = Type.Integer({ minimum: 0 });
const TimeoutServersSchema = Type.Record(Type.String({ minLength: 1 }), TimeoutValueSchema);
const MCPTimeoutOverridesSchema = Type.Object({
	sources: Type.Optional(Type.Record(Type.String({ minLength: 1 }), TimeoutServersSchema)),
});

type MCPTimeoutOverridesConfig = Static<typeof MCPTimeoutOverridesSchema>;
type MCPTimeoutSourceMap = NonNullable<MCPTimeoutOverridesConfig["sources"]>;

const USER_MCP_TIMEOUT_OVERRIDES = new ConfigFile<MCPTimeoutOverridesConfig>("mcp-timeouts", MCPTimeoutOverridesSchema);

export interface LoadedMCPTimeoutOverrides {
	user: MCPTimeoutSourceMap;
	project: MCPTimeoutSourceMap;
}

export function getMcpTimeoutOverridesPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	return scope === "user"
		? path.join(getAgentDir(), "mcp-timeouts.yml")
		: path.join(cwd, getConfigDirName(), "mcp-timeouts.yml");
}

function getTimeoutOverridesFile(scope: "user" | "project", cwd: string): ConfigFile<MCPTimeoutOverridesConfig> {
	return scope === "user"
		? USER_MCP_TIMEOUT_OVERRIDES
		: USER_MCP_TIMEOUT_OVERRIDES.relocate(getMcpTimeoutOverridesPath(scope, cwd));
}

function normalizeSourcePathKey(sourcePath: string, scope: "user" | "project", cwd: string): string {
	if (scope !== "project") return sourcePath;
	const relativePath = path.relative(cwd, sourcePath);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return sourcePath;
	}
	return relativePath;
}

function resolveOverrideScope(level: SourceMeta["level"]): "user" | "project" | undefined {
	return level === "user" || level === "project" ? level : undefined;
}

function readTimeoutOverrides(scope: "user" | "project", cwd: string): MCPTimeoutSourceMap {
	const file = getTimeoutOverridesFile(scope, cwd);
	const result = file.tryLoad();
	return result.status === "ok" ? (result.value.sources ?? {}) : {};
}

export function loadMcpTimeoutOverrides(cwd: string = getProjectDir()): LoadedMCPTimeoutOverrides {
	return {
		user: readTimeoutOverrides("user", cwd),
		project: readTimeoutOverrides("project", cwd),
	};
}

export function getMcpTimeoutOverride(
	overrides: LoadedMCPTimeoutOverrides,
	source: Pick<SourceMeta, "level" | "path">,
	serverName: string,
	cwd: string = getProjectDir(),
): number | undefined {
	const scope = resolveOverrideScope(source.level);
	if (!scope) return undefined;
	const sourceKey = normalizeSourcePathKey(source.path, scope, cwd);
	return overrides[scope][sourceKey]?.[serverName];
}

export function applyMcpTimeoutOverrideToServer(
	server: MCPServer,
	overrides: LoadedMCPTimeoutOverrides,
	cwd: string = getProjectDir(),
): MCPServer {
	const timeout = getMcpTimeoutOverride(overrides, server._source, server.name, cwd);
	return timeout === undefined ? server : { ...server, timeout };
}

export function applyMcpTimeoutOverrideToConfig(
	name: string,
	config: MCPServerConfig,
	source: Pick<SourceMeta, "level" | "path">,
	overrides: LoadedMCPTimeoutOverrides,
	cwd: string = getProjectDir(),
): MCPServerConfig {
	const timeout = getMcpTimeoutOverride(overrides, source, name, cwd);
	return timeout === undefined ? config : { ...config, timeout };
}

export async function setMcpTimeoutOverride(options: {
	scope: "user" | "project";
	cwd?: string;
	sourcePath: string;
	serverName: string;
	timeoutMs: number | undefined;
}): Promise<void> {
	const cwd = options.cwd ?? getProjectDir();
	const file = getTimeoutOverridesFile(options.scope, cwd);
	const nextSources = { ...readTimeoutOverrides(options.scope, cwd) };
	const sourceKey = normalizeSourcePathKey(options.sourcePath, options.scope, cwd);
	const nextServers = { ...(nextSources[sourceKey] ?? {}) };

	if (options.timeoutMs !== undefined) {
		if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0) {
			throw new Error("MCP timeout must be an integer >= 0.");
		}
		nextServers[options.serverName] = options.timeoutMs;
	} else {
		delete nextServers[options.serverName];
	}

	if (Object.keys(nextServers).length === 0) {
		delete nextSources[sourceKey];
	} else {
		nextSources[sourceKey] = nextServers;
	}

	await Bun.write(file.path(), Bun.YAML.stringify({ sources: nextSources }));
	file.invalidate();
}

export function formatMcpTimeoutDisplay(timeoutMs: number | undefined): string {
	if (timeoutMs === 0) return "Disabled";
	if (typeof timeoutMs === "number") return `${timeoutMs} ms`;
	return `Default (${DEFAULT_MCP_TIMEOUT_MS} ms)`;
}
