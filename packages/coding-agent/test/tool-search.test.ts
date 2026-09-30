import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolNamespace } from "../src/core/extensions/types.ts";
import { createCodemodeDescription } from "../src/extensions/codemode/tool.ts";
import {
	Bm25Ranker,
	createToolSearchDescription,
	createToolSearchDocument,
	tokenize,
} from "../src/extensions/tool-search/tool.ts";

function tool(name: string, description: string, properties: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Unsafe({ type: "object", properties }),
		execute: async () => ({ content: [], details: undefined }),
	};
}

describe("tokenize", () => {
	it("splits camelCase and snake_case, drops stop words, and folds plurals", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
	});
});

describe("Bm25Ranker", () => {
	const tools = [
		tool("mcp__github__list_issues", "List issues in a repository.", {
			state: { type: "string", description: "open or closed" },
		}),
		tool("mcp__github__create_pull_request", "Open a pull request."),
		tool("mcp__linear__search_issues", "Search Linear issues by text."),
		tool("mcp__docs__search", "Search the documentation."),
	];
	const documents = tools.map((entry) => createToolSearchDocument(entry));

	it("ranks by term relevance and respects the limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("issue", documents, 8).map((match) => match.name)).toEqual([
			"mcp__linear__search_issues",
			"mcp__github__list_issues",
		]);
		expect(ranker.rank("pull requests", documents, 8)[0].name).toBe("mcp__github__create_pull_request");
		expect(ranker.rank("search", documents, 1)).toHaveLength(1);
		// Property names and descriptions are searchable.
		expect(ranker.rank("closed", documents, 8).map((match) => match.name)).toEqual(["mcp__github__list_issues"]);
	});

	it("returns nothing for unknown or empty queries", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("kubernetes", documents, 8)).toEqual([]);
		expect(ranker.rank("the", documents, 8)).toEqual([]);
		// Known v1 limit: no synonyms, so "tickets" does not find "issues".
		expect(ranker.rank("tickets", documents, 8)).toEqual([]);
	});

	it("includes the namespace in the search text", () => {
		const document = createToolSearchDocument(tool("mcp__x__run", "Run it."), {
			name: "mcp__x",
			description: "Kubernetes cluster tools",
		});
		expect(new Bm25Ranker().rank("kubernetes", [document], 8)).toEqual([
			{ name: "mcp__x__run", score: expect.any(Number) },
		]);
	});
});

describe("tool_search description", () => {
	it("lists the sources", () => {
		expect(
			createToolSearchDescription([{ name: "mcp__docs", description: "Docs server\nmore" }, { name: "mcp__x" }]),
		).toBe(
			"# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nYou have access to tools from the following sources:\n- mcp__docs: Docs server\n- mcp__x\n\nSome of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search`.",
		);
		expect(createToolSearchDescription()).toContain("None currently enabled.");
	});
});

describe("codemode description catalog", () => {
	const plain = tool("read_notes", "Read notes.");
	const github = ["a", "b", "c"].map((suffix) => tool(`mcp__github__${suffix}`, `GitHub ${suffix}.`));
	const docs = [tool("mcp__docs__search", "Search docs."), tool("mcp__docs__long", "Long ".repeat(200))];
	const all = [plain, ...github, ...docs];
	const namespaces = new Map<string, ToolNamespace>([
		...github.map((entry) => [entry.name, { name: "mcp__github", description: "GitHub server" }] as const),
		...docs.map((entry) => [entry.name, { name: "mcp__docs" }] as const),
	]);

	it("lists everything without a budget", () => {
		const description = createCodemodeDescription(all, { namespaces });
		expect(description).toContain("Nested tools: COMPLETE list (6 tools).");
		expect(description).toContain("## mcp__github (3 tools)\nGitHub server");
		expect(description).toContain("## mcp__docs (2 tools)\n\n### `mcp__docs");
		expect(description).not.toContain("Some deferred nested tools");
	});

	it("fills the budget round-robin, cheapest first, and says what is missing", () => {
		// Each small section costs about 42 tokens: one tool per group, then one more.
		const description = createCodemodeDescription(all, { namespaces, inlineBudget: 170 });
		expect(description).toContain("Nested tools: PARTIAL - 4 of 6 shown.");
		expect(description).toContain("### `read_notes`");
		expect(description).toContain("## mcp__docs (2 tools, 1 shown)");
		expect(description).toContain("### `mcp__docs__search`");
		expect(description).not.toContain("### `mcp__docs__long`");
		expect(description).toContain("## mcp__github (3 tools, 2 shown)");
		expect(description).toContain("To find one, call `await searchTools(query)`");
		// Deterministic: the same input gives the same description.
		expect(createCodemodeDescription(all, { namespaces, inlineBudget: 170 })).toBe(description);
	});

	it("never lists deferred tools and still counts them", () => {
		const description = createCodemodeDescription(all, {
			namespaces,
			deferred: new Set(github.map((entry) => entry.name)),
		});
		expect(description).toContain("Nested tools: PARTIAL - 3 of 6 shown.");
		expect(description).toContain("## mcp__github (3 tools, none shown)\nGitHub server");
		expect(description).not.toContain("### `mcp__github__a`");
		expect(description).toContain("Some deferred nested tools may be omitted from this description.");
	});

	it("lists only namespaces with a zero budget", () => {
		const description = createCodemodeDescription(all, { namespaces, inlineBudget: 0 });
		expect(description).toContain("Nested tools: PARTIAL - 0 of 6 shown.");
		expect(description).toContain("## mcp__docs (2 tools, none shown)");
		expect(description).not.toContain("codemode tool declaration:");
	});
});
