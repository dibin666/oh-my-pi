import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "../../src/mcp/config";
import { setMcpTimeoutOverride } from "../../src/mcp/timeout-overrides";
import { loadAllExtensions } from "../../src/modes/components/extensions/state-manager";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
	const originalEnv = {
		PI_OAUTH_TOKEN_URL: process.env.PI_OAUTH_TOKEN_URL,
		PI_OAUTH_CLIENT_ID: process.env.PI_OAUTH_CLIENT_ID,
		PI_OAUTH_CLIENT_SECRET: process.env.PI_OAUTH_CLIENT_SECRET,
		PI_OAUTH_REDIRECT_URI: process.env.PI_OAUTH_REDIRECT_URI,
		PI_OAUTH_CALLBACK_PATH: process.env.PI_OAUTH_CALLBACK_PATH,
		PI_MCP_HEADER: process.env.PI_MCP_HEADER,
		PI_MCP_URL: process.env.PI_MCP_URL,
		PI_MCP_ENV: process.env.PI_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-json-"));
		process.env.PI_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.PI_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.PI_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.PI_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.PI_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.PI_MCP_HEADER = "Bearer test-token";
		process.env.PI_MCP_URL = "https://mcp.example.com";
		process.env.PI_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("PI_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("PI_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("PI_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("PI_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});

describe("MCP timeout overrides", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-timeout-overrides-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("loadAllMCPConfigs applies project timeout overrides per server", async () => {
		const primaryServer = "mcp-timeout-primary-test";
		const disabledServer = "mcp-timeout-disabled-test";
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[primaryServer]: { command: "claude-code-mcp", timeout: 45_000 },
					[disabledServer]: { command: "github-mcp" },
				},
			}),
		);

		await setMcpTimeoutOverride({
			scope: "project",
			cwd: tempDir,
			sourcePath: path.join(tempDir, "mcp.json"),
			serverName: primaryServer,
			timeoutMs: 120_000,
		});
		await setMcpTimeoutOverride({
			scope: "project",
			cwd: tempDir,
			sourcePath: path.join(tempDir, "mcp.json"),
			serverName: disabledServer,
			timeoutMs: 0,
		});

		const result = await loadAllMCPConfigs(tempDir, { filterExa: false });
		expect(result.configs[primaryServer]?.timeout).toBe(120_000);
		expect(result.configs[disabledServer]?.timeout).toBe(0);
	});

	test("loadAllExtensions exposes overridden MCP timeout values in the extensions dashboard", async () => {
		const serverName = "mcp-timeout-extension-test";
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[serverName]: { command: "claude-code-mcp" },
				},
			}),
		);
		await setMcpTimeoutOverride({
			scope: "project",
			cwd: tempDir,
			sourcePath: path.join(tempDir, "mcp.json"),
			serverName,
			timeoutMs: 180_000,
		});

		const extensions = await loadAllExtensions(tempDir, []);
		const mcpExtension = extensions.find(ext => ext.kind === "mcp" && ext.name === serverName);
		const raw = mcpExtension?.raw as MCPServer | undefined;

		expect(mcpExtension?.source.level).toBe("project");
		expect(raw?.timeout).toBe(180_000);
	});

	test("clearing a timeout override falls back to the source config value", async () => {
		const serverName = "mcp-timeout-clear-test";
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[serverName]: { command: "claude-code-mcp", timeout: 45_000 },
				},
			}),
		);
		const sourcePath = path.join(tempDir, "mcp.json");
		await setMcpTimeoutOverride({
			scope: "project",
			cwd: tempDir,
			sourcePath,
			serverName,
			timeoutMs: 120_000,
		});
		await setMcpTimeoutOverride({
			scope: "project",
			cwd: tempDir,
			sourcePath,
			serverName,
			timeoutMs: undefined,
		});

		const result = await loadAllMCPConfigs(tempDir, { filterExa: false });
		expect(result.configs[serverName]?.timeout).toBe(45_000);
	});
});
