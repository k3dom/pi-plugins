/**
 * Built-in MCP integration.
 *
 * Connects the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()` when a session starts, and servers registered later right away. A server
 * in `mcp.json` takes precedence over a registered server of the same name. Tools are registered as
 * `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only callable from
 * codemode scripts, which keeps large MCP tool lists out of the model's tool declarations; the
 * codemode tool is activated for that unless `autoEnableCodemode` is false. `"codemode-deferred"`
 * leaves them out of the codemode description as well. `"deferred"` declares them to the model once
 * the `tool_search` tool loads them, and activates `tool_search` instead of codemode.
 * `"exposure": "direct"` declares them to the model right away, and `"hidden"` makes them
 * unreachable. `toolExposure` overrides the exposure of single tools. Servers with resources are
 * reached through Codex's `list_mcp_resources`, `list_mcp_resource_templates`, and
 * `read_mcp_resource` tools (resources.ts).
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools.
 *
 * Problems found at startup (config errors, failed connections, servers that need a sign-in) are
 * reported once. `/mcp` opens a manager to sign in, reconnect, enable or disable servers, and change
 * their exposure; the last two are saved to the `mcp.json` that defines the server, or apply to the
 * current session for registered servers.
 */

import { join, resolve } from "node:path";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME, isCodemodeTool } from "../codemode/tool.ts";
import { isToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
import { createMcpResourceToolDefinitions } from "./resources.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

export type { McpTransportFactory } from "./runtime.ts";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Saves `/mcp` changes to the server's config file. Defaults to editing its `mcp.json`. */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers that are still connecting at startup, in
	 * milliseconds. Their tools become available when they connect. Default: 10000.
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/** A configured server. Disabled servers have no connection. */
interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "called from codemode scripts, listed in the codemode description",
	"codemode-deferred": "called from codemode scripts, not listed; scripts find them with searchTools()",
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	direct: "declared to the model like built-in tools",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: McpServer): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "starting";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, resources } = connection;
			const count = resources.length;
			const resourceCount = count > 0 ? ` · ${count} resource${count === 1 ? "" : "s"}` : "";
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${resourceCount}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/** Servers that need the user first. */
function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		let overridden: string[] = [];
		/** Between session_start and session_shutdown. Registrations before that are read on session_start. */
		let sessionActive = false;
		let autoEnableCodemode = true;
		/** Whether the "codemode tools unreachable" warning was shown since the session started. */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Bumped on every session start and shutdown so a runtime load that resolves late is dropped. */
		let generation = 0;
		/** Working directory of the session, for stdio servers. */
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ?? ((entry, patch) => updateMcpServerConfig(entry.source, entry.name, patch));

		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				const configured = configuredEntries.find((entry) => entry.name === name);
				if (configured) {
					overriddenNames.push(`"${name}" registered by ${extensionPath} is overridden by ${configured.source}`);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		const serverTools = new Map<string, Set<string>>();
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();

		const registerTools = (connection: McpServerConnection) => {
			const server = connection.entry.name;
			const entry = findServer(server)?.entry ?? connection.entry;
			const namespaceName = `mcp__${server}`;
			const namespace = {
				name: namespaceName,
				description: connection.instructions ?? `Tools in the ${namespaceName} namespace.`,
			};
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			const assignName = (tool: string, owner: string) => {
				const name = createMcpToolName(server, tool, (candidate) => {
					const existing = toolOwners.get(candidate);
					return (existing !== undefined && existing !== owner) || current.has(candidate);
				});
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			for (const tool of connection.tools) {
				const definition = createMcpToolDefinition({
					server,
					tool,
					name: assignName(tool.name, `${server}\0${tool.name}`),
					exposure: getMcpToolExposure(entry.config, tool.name),
					namespace,
					timeoutMs: connection.timeoutMs,
					getClient: async () => connection,
					readableResources: () => resourceServers().includes(connection),
				});
				definitions.set(definition.name, definition);
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			for (const name of previous) {
				const definition = definitions.get(name);
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			syncResourceTools();
		};

		/** Make a disabled server's tools unreachable. */
		const hideTools = (server: string) => {
			for (const name of serverTools.get(server) ?? []) {
				const definition = definitions.get(name);
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			serverTools.set(server, new Set());
			syncResourceTools();
		};

		/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			const exposure = (["direct", "codemode", "codemode-deferred", "deferred"] as const).find((candidate) =>
				exposures.has(candidate),
			);
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			if (wasDirect) {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		/**
		 * Tools that are not declared to the model are reached through the codemode tool (scripts call
		 * them) or the tool_search tool (it declares them). Either reaches every such tool. Activate the
		 * one the tools' exposure asks for: codemode for `codemode` and `codemode-deferred` unless
		 * `autoEnableCodemode` is false, tool_search for `deferred`.
		 */
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			const exposures = new Set<McpExposure>();
			for (const { connection, entry } of servers) {
				if (connection?.state !== "connected") continue;
				// Resource tools share the server's exposure.
				if (connection.hasResources) exposures.add(exposureOf(entry));
				for (const tool of connection.tools) exposures.add(getMcpToolExposure(entry.config, tool.name));
			}
			const needsCodemode = exposures.has("codemode") || exposures.has("codemode-deferred");
			const needsToolSearch = exposures.has("deferred");
			if (!needsCodemode && !needsToolSearch) return;
			// Other extensions' tools of the same names cannot reach MCP tools, so never activate them.
			const tools = pi.getAllTools();
			const hasCodemode = tools.some(isCodemodeTool);
			const hasToolSearch = tools.some(isToolSearchTool);
			const active = pi.getActiveTools();
			const activate: string[] = [];
			if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
				activate.push(CODEMODE_TOOL_NAME);
			}
			if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
			const reachable = [...active, ...activate];
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			if (warnedUnreachable) return;
			warnedUnreachable = true;
			const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
			ctx.ui.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		};

		/**
		 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
		 * `pi mcp login` in another process (for example run by the agent) changes them.
		 */
		const tokensAtSignIn = new Map<McpServerConnection, string>();
		const storedTokens = (connection: McpServerConnection): string => {
			const url = connection.oauthUrl;
			return url && credentials ? JSON.stringify(credentials.tokens(url) ?? null) : "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			emitChange();
		};
		/** Reconnect servers that need a sign-in when their credentials were stored since. */
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			if (signedIn.length === 0) return;
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
			ensureDiscoveryActive(ctx);
		};

		/** Create the server's connection, loading the MCP runtime on first use. */
		const createConnection = async (server: McpServer): Promise<McpServerConnection> => {
			const runtime = await loadMcpRuntime();
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				log: getServerLog(runtime),
				onTools: registerTools,
				onChange: onConnectionChange,
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session.
		 */
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch): string | undefined => {
			if (server.entry.scope !== "extension") {
				try {
					updateConfig(server.entry, patch);
				} catch (error) {
					return `Could not update ${server.entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...server.entry, config: { ...server.entry.config, ...patch } };
			return undefined;
		};

		const signIn = async (server: McpServer, prompt: McpSignInPrompt): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			try {
				await runtime.signInMcpServer({
					serverUrl: url,
					store: getCredentials(runtime).forServer(url),
					settings: connection.oauthSettings(),
					challenge: connection.challenge,
					prompt,
				});
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// The challenge that asked for this sign-in (for example for more scope) is answered.
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = getCredentials(await loadMcpRuntime()).remove(url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			try {
				await connection.reconnect();
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		const setEnabled = async (server: McpServer, enabled: boolean): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled });
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.connection = undefined;
				hideTools(server.entry.name);
				emitChange();
				await connection?.close();
				return undefined;
			}
			const connection = await createConnection(server);
			await connection.getClient().catch(() => undefined);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			if (server.connection?.state === "connected") registerTools(server.connection);
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.scope ?? server.entry.source}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension"
					? "for this session"
					: entry.scope
						? `saved to the ${entry.scope} mcp.json`
						: "saved to mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (state === "connected" && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if (state === "connected" && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { name } = server.entry;
			let message: string | undefined;
			switch (action) {
				case "signin": {
					const title = `Sign in to ${name}`;
					let authorizationUrl = "";
					ui.status(title, "Contacting the authorization server…");
					message = await signIn(server, {
						showAuthorizationUrl: (url) => {
							authorizationUrl = url.href;
							openUrl(url.href);
						},
						promptForRedirectUrl: async (signal) => {
							const value = await ui.redirectUrl(title, authorizationUrl, signal);
							ui.status(title, "Connecting…");
							return value;
						},
					});
					break;
				}
				case "reconnect":
					// A failure shows as the connection's state and error.
					ui.status(`MCP server ${name}`, "Reconnecting…");
					await reconnect(server);
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
					ui.status(`MCP server ${name}`, action === "enable" ? "Connecting…" : "Disconnecting…");
					message = await setEnabled(server, action === "enable");
					break;
			}
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				const state = !isEnabled(server)
					? "disabled"
					: connection?.state === "disconnected"
						? "disconnected, reconnects on next call"
						: (connection?.state ?? "starting");
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const failure = await signIn(server, {
				showAuthorizationUrl: (url) => {
					ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
					openUrl(url.href);
				},
				promptForRedirectUrl: (signal) =>
					ctx.ui.input(
						`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
						"http://127.0.0.1:.../callback?code=...",
						{ signal },
					),
			});
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			const current = ++generation;
			sessionActive = true;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			emitChange();
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			pending = new Promise((resolve) => setImmediate(resolve))
				.then(() => loadMcpRuntime())
				.then(async () => {
					if (current !== generation) return;
					const started = await Promise.all(enabled.map((server) => createConnection(server)));
					if (current !== generation) return;
					await Promise.allSettled(started.map((connection) => connection.getClient()));
					if (current !== generation) return;
					ensureDiscoveryActive(ctx);
					reportProblems(ctx);
				})
				.catch((error: unknown) => {
					// The session may have been disposed meanwhile, which makes ctx stale.
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		// The first prompt waits for startup connections so their tools are available to it, but not
		// indefinitely: a slow or hanging server must not hold up the prompt.
		pi.on("before_agent_start", async (_event, ctx) => {
			const startup = pending;
			if (!startup || waitedForStartup) return;
			waitedForStartup = true;
			let timer: NodeJS.Timeout | undefined;
			const finished = await Promise.race([
				startup.then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), startupWaitMs);
				}),
			]);
			clearTimeout(timer);
			if (!finished) {
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		});

		// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
		pi.on("turn_start", async (_event, ctx) => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// Servers registered or unregistered during the session connect or disconnect right away.
		pi.on("mcp_servers_change", async (_event, ctx) => {
			if (!sessionActive) return;
			const current = generation;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			// Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			for (const server of removed) hideTools(server.entry.name);
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			emitChange();
			await Promise.all(removed.map((server) => server.connection?.close()));
			const connecting = added.filter(isEnabled);
			if (current !== generation || connecting.length === 0) return;
			try {
				const started = await Promise.all(connecting.map((server) => createConnection(server)));
				if (current !== generation) {
					await Promise.all(started.map((connection) => connection.close()));
					return;
				}
				await Promise.allSettled(started.map((connection) => connection.getClient()));
			} catch (error) {
				ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				return;
			}
			if (current !== generation) return;
			ensureDiscoveryActive(ctx);
			reportProblems(ctx, connecting);
		});

		pi.on("session_shutdown", async () => {
			sessionActive = false;
			generation++;
			const closing = connections();
			servers = [];
			emitChange();
			await Promise.all(closing.map((connection) => connection.close()));
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				await pending;
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else ctx.ui.notify(formatStatus(), "info");
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
