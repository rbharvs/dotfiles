import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildWebFetchRequest,
	buildWebSearchTool,
	classifyWebSearchToolError,
	formatWebFetchResult,
	parseWebFetchResponse,
	type WebFetchDetails,
} from "./core.ts";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = process.env.PI_ANTHROPIC_WEB_MODEL || "claude-sonnet-5";
const DEFAULT_MAX_USES = Number(process.env.PI_WEB_SEARCH_MAX_USES) || 8;
const DEFAULT_MAX_CONTENT_TOKENS =
	Number(process.env.PI_WEB_FETCH_MAX_CONTENT_TOKENS) || 50_000;
const configuredTimeoutMs = Number(process.env.PI_ANTHROPIC_WEB_TIMEOUT_MS);
const DEFAULT_TIMEOUT_MS =
	Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
		? configuredTimeoutMs
		: 60_000;
const DEFAULT_MAX_TOKENS = 4096;

const UserLocation = Type.Object({
	type: Type.Literal("approximate"),
	city: Type.Optional(Type.String()),
	region: Type.Optional(Type.String()),
	country: Type.Optional(Type.String({ description: "Two-letter country code, e.g. 'US'" })),
	timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. 'America/Los_Angeles'" })),
});

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"The natural-language search query. Claude will decide what to search the web for based on this query.",
	}),
	max_uses: Type.Optional(
		Type.Integer({
			description: `Maximum number of searches Claude may run for this query. Default: ${DEFAULT_MAX_USES}.`,
			minimum: 1,
			maximum: 10,
		}),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Only include results from these domains. Cannot be used with blocked_domains.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude results from these domains. Cannot be used with allowed_domains.",
		}),
	),
	user_location: Type.Optional(UserLocation),
});

const WebFetchParams = Type.Object({
	url: Type.String({
		description: "The URL of the web page or PDF to fetch and read.",
	}),
	focus: Type.Optional(
		Type.String({
			description:
				"Optional instruction describing what to extract, analyze, or summarize from the URL.",
		}),
	),
	max_content_tokens: Type.Optional(
		Type.Integer({
			description: `Maximum fetched content length in tokens. Default: ${DEFAULT_MAX_CONTENT_TOKENS}.`,
			minimum: 1,
			maximum: 100_000,
		}),
	),
});

// Response fields consumed from Anthropic's hosted tools.

interface ServerToolUseBlock {
	type: "server_tool_use";
	id: string;
	name: string;
	input: { query?: string } & Record<string, unknown>;
}

interface WebSearchResultItem {
	type: "web_search_result";
	url: string;
	title: string;
	page_age?: string | null;
}

interface WebSearchResultBlock {
	type: "web_search_tool_result";
	tool_use_id: string;
	content:
		| WebSearchResultItem[]
		| { type: "web_search_tool_result_error"; error_code: string };
}

interface TextCitation {
	type: "web_search_result_location";
	url: string;
	title: string;
	cited_text?: string;
	encrypted_index?: string;
}

interface TextBlock {
	type: "text";
	text: string;
	citations?: TextCitation[];
}

type ContentBlock = ServerToolUseBlock | WebSearchResultBlock | TextBlock | { type: string };

interface MessagesResponse {
	id: string;
	model: string;
	stop_reason: string | null;
	content: ContentBlock[];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		server_tool_use?: {
			web_search_requests?: number;
			web_fetch_requests?: number;
		};
	};
}

interface Source {
	url: string;
	title: string;
	page_age?: string | null;
}

interface WebSearchDetails {
	query: string;
	model: string;
	queriesRun: string[];
	sources: Source[];
	searchRequests: number;
	inputTokens: number;
	outputTokens: number;
	stopReason: string | null;
	warning?: string;
	error?: string;
}

function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === "text";
}

function isServerToolUse(b: ContentBlock): b is ServerToolUseBlock {
	return b.type === "server_tool_use";
}

function isWebSearchResult(b: ContentBlock): b is WebSearchResultBlock {
	return b.type === "web_search_tool_result";
}

async function resolveApiKey(ctx: ExtensionContext): Promise<string> {
	const resolved = await ctx.modelRegistry.getProviderAuth("anthropic");
	const apiKey = resolved?.auth.apiKey?.trim();
	if (apiKey) return apiKey;
	throw new Error(
		"No Anthropic API key is configured in Pi's credential store. Run `/login` and configure Anthropic API-key authentication.",
	);
}

function buildHeaders(apiKey: string): Record<string, string> {
	// Hosted tools require API access; subscription credentials may be rejected.
	return {
		"content-type": "application/json",
		"anthropic-version": ANTHROPIC_VERSION,
		"x-api-key": apiKey,
	};
}

interface AnthropicRequestBody extends Record<string, unknown> {
	messages: unknown[];
}

async function callAnthropic(
	body: AnthropicRequestBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<MessagesResponse> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	const requestSignal = signal
		? AbortSignal.any([signal, timeoutSignal])
		: timeoutSignal;
	let requestBody = body;
	const content: ContentBlock[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let searchRequests = 0;
	let fetchRequests = 0;

	for (let continuation = 0; continuation < 4; continuation += 1) {
		let response: Response;
		try {
			response = await fetch(ANTHROPIC_MESSAGES_URL, {
				method: "POST",
				headers: buildHeaders(apiKey),
				body: JSON.stringify(requestBody),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			if (timeoutSignal.aborted) {
				throw new Error(`Anthropic request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
			}
			throw new Error(
				`Network error calling Anthropic: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`Anthropic API returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
			);
		}

		let payload: MessagesResponse;
		try {
			payload = (await response.json()) as MessagesResponse;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (timeoutSignal.aborted) {
				throw new Error(`Anthropic request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
			}
			throw error;
		}
		content.push(...(payload.content ?? []));
		inputTokens += payload.usage?.input_tokens ?? 0;
		outputTokens += payload.usage?.output_tokens ?? 0;
		cacheReadInputTokens += payload.usage?.cache_read_input_tokens ?? 0;
		cacheCreationInputTokens += payload.usage?.cache_creation_input_tokens ?? 0;
		searchRequests += payload.usage?.server_tool_use?.web_search_requests ?? 0;
		fetchRequests += payload.usage?.server_tool_use?.web_fetch_requests ?? 0;

		if (payload.stop_reason !== "pause_turn") {
			return {
				...payload,
				content,
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					cache_read_input_tokens: cacheReadInputTokens,
					cache_creation_input_tokens: cacheCreationInputTokens,
					server_tool_use: {
						web_search_requests: searchRequests,
						web_fetch_requests: fetchRequests,
					},
				},
			};
		}

		requestBody = {
			...requestBody,
			messages: [
				...requestBody.messages,
				{ role: "assistant", content: payload.content },
			],
		};
	}

	throw new Error("Anthropic server tool remained paused after 4 requests");
}

function* walkContentBlocks(value: unknown): Generator<ContentBlock> {
	if (Array.isArray(value)) {
		for (const item of value) yield* walkContentBlocks(item);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.type === "string") yield record as ContentBlock;
	for (const child of Object.values(record)) yield* walkContentBlocks(child);
}

function dedupeSources(blocks: ContentBlock[]): Source[] {
	const seen = new Set<string>();
	const sources: Source[] = [];
	for (const block of walkContentBlocks(blocks)) {
		if (isWebSearchResult(block) && Array.isArray(block.content)) {
			for (const item of block.content) {
				if (item.type !== "web_search_result" || seen.has(item.url)) continue;
				seen.add(item.url);
				sources.push({ url: item.url, title: item.title, page_age: item.page_age ?? null });
			}
			continue;
		}
		if (!isTextBlock(block) || !Array.isArray(block.citations)) continue;
		for (const citation of block.citations) {
			if (citation.type !== "web_search_result_location" || seen.has(citation.url)) continue;
			seen.add(citation.url);
			sources.push({ url: citation.url, title: citation.title, page_age: null });
		}
	}
	return sources;
}

function collectQueries(blocks: ContentBlock[]): string[] {
	const queries: string[] = [];
	for (const block of walkContentBlocks(blocks)) {
		if (!isServerToolUse(block) || block.name !== "web_search") continue;
		const q = block.input?.query;
		if (typeof q === "string" && q.trim()) queries.push(q.trim());
	}
	return queries;
}

function collectText(blocks: ContentBlock[]): string {
	return blocks
		.filter(isTextBlock)
		.map((b) => b.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

function formatResult(answer: string, sources: Source[], details: WebSearchDetails): string {
	const lines: string[] = [];
	if (answer) lines.push(answer);

	if (sources.length > 0) {
		lines.push("");
		lines.push("Sources:");
		sources.forEach((s, i) => {
			const age = s.page_age ? ` (${s.page_age})` : "";
			lines.push(`[${i + 1}] ${s.title}${age} — ${s.url}`);
		});
	}

	if (details.queriesRun.length > 1) {
		lines.push("");
		lines.push(`Search queries executed: ${details.queriesRun.map((q) => `"${q}"`).join(", ")}`);
	}

	if (details.warning) {
		lines.push("", `Warning: ${details.warning}`);
	}

	lines.push("");
	lines.push(
		`[model=${details.model}, searches=${details.searchRequests}, in=${details.inputTokens}, out=${details.outputTokens}]`,
	);
	return lines.join("\n").trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: [
			"Search the web and return a synthesized, cited answer.",
			"Implemented via Anthropic's server-side web_search tool — the model",
			`(default: ${DEFAULT_MODEL}) may run up to max_uses (default ${DEFAULT_MAX_USES}) searches to answer.`,
			"Results include source URLs.",
			"Use for up-to-date information, breaking news, recent changes, or anything beyond your training cutoff.",
		].join(" "),
		promptSnippet: "Search the web and return a synthesized, cited answer.",
		promptGuidelines: [
			"Use web_search for information that may be newer than your training data, for breaking news, or when the user explicitly asks you to search the web.",
			"Prefer web_search over guessing when recency matters. Cite the returned URLs in your reply.",
		],
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.allowed_domains && params.blocked_domains) {
				throw new Error("allowed_domains and blocked_domains are mutually exclusive");
			}

			const apiKey = await resolveApiKey(ctx);
			const model = DEFAULT_MODEL;

			const tool = buildWebSearchTool({
				maxUses: params.max_uses ?? DEFAULT_MAX_USES,
				allowedDomains: params.allowed_domains,
				blockedDomains: params.blocked_domains,
				userLocation: params.user_location,
			});

			const body = {
				model,
				max_tokens: DEFAULT_MAX_TOKENS,
				messages: [{ role: "user", content: params.query }],
				tools: [tool],
			};

			onUpdate?.({
				content: [{ type: "text", text: `Searching: "${params.query}"...` }],
				details: {
					query: params.query,
					model,
					queriesRun: [],
					sources: [],
					searchRequests: 0,
					inputTokens: 0,
					outputTokens: 0,
					stopReason: null,
				} satisfies WebSearchDetails,
			});

			let payload: MessagesResponse;
			try {
				payload = await callAnthropic(body, apiKey, signal);
			} catch (error) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Search cancelled." }],
						details: {
							query: params.query,
							model,
							queriesRun: [],
							sources: [],
							searchRequests: 0,
							inputTokens: 0,
							outputTokens: 0,
							stopReason: "cancelled",
						} satisfies WebSearchDetails,
					};
				}
				throw error;
			}
			const blocks = payload.content ?? [];
			const answer = collectText(blocks);
			const sources = dedupeSources(blocks);
			const queriesRun = collectQueries(blocks);

			const details: WebSearchDetails = {
				query: params.query,
				model: payload.model || model,
				queriesRun,
				sources,
				searchRequests: payload.usage?.server_tool_use?.web_search_requests ?? 0,
				inputTokens: payload.usage?.input_tokens ?? 0,
				outputTokens: payload.usage?.output_tokens ?? 0,
				stopReason: payload.stop_reason,
			};

			// Surface structured errors, including results nested by dynamic filtering.
			// Anthropic may return useful partial results before hitting max_uses.
			for (const block of walkContentBlocks(blocks)) {
				if (!isWebSearchResult(block) || Array.isArray(block.content)) continue;
				Object.assign(
					details,
					classifyWebSearchToolError(
						block.content.error_code,
						Boolean(answer || sources.length > 0),
					),
				);
				break;
			}

			if (!answer && !sources.length) {
				const errText = details.error
					? `Web search failed: ${details.error}`
					: "Web search returned no content.";
				return {
					content: [{ type: "text", text: errText }],
					details,
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: formatResult(answer, sources, details) }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			const q = typeof args.query === "string" ? args.query : "";
			text += theme.fg("accent", q ? `"${q}"` : "...");
			const filters: string[] = [];
			if (Array.isArray(args.allowed_domains) && args.allowed_domains.length) {
				filters.push(`allowed:${args.allowed_domains.join(",")}`);
			}
			if (Array.isArray(args.blocked_domains) && args.blocked_domains.length) {
				filters.push(`blocked:${args.blocked_domains.join(",")}`);
			}
			if (typeof args.max_uses === "number") filters.push(`max_uses=${args.max_uses}`);
			if (filters.length) text += " " + theme.fg("dim", `(${filters.join(" ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}
			const details = result.details as WebSearchDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			const header =
				theme.fg("success", `✓ ${details.searchRequests} search${details.searchRequests === 1 ? "" : "es"}`) +
				theme.fg("muted", `, ${details.sources.length} source${details.sources.length === 1 ? "" : "s"}`);

			if (!expanded) {
				let text = header;
				if (details.warning) {
					text += `\n  ${theme.fg("warning", `⚠ ${details.warning}`)}`;
				}
				const top = details.sources.slice(0, 3);
				for (const s of top) {
					text += `\n  ${theme.fg("dim", "• ")}${theme.fg("accent", s.title)} ${theme.fg("dim", s.url)}`;
				}
				if (details.sources.length > top.length) {
					text += `\n  ${theme.fg("muted", `... +${details.sources.length - top.length} more (Ctrl+O to expand)`)}`;
				}
				return new Text(text, 0, 0);
			}

			let text = header;
			if (details.warning) {
				text += `\n${theme.fg("warning", `⚠ ${details.warning}`)}`;
			}
			text += "\n" + theme.fg("dim", `model=${details.model}  in=${details.inputTokens}  out=${details.outputTokens}`);
			if (details.queriesRun.length) {
				text += "\n" + theme.fg("muted", "Queries: ") + details.queriesRun.map((q) => `"${q}"`).join(", ");
			}
			for (const s of details.sources) {
				const age = s.page_age ? ` ${theme.fg("dim", `(${s.page_age})`)}` : "";
				text += `\n  ${theme.fg("dim", "•")} ${theme.fg("accent", s.title)}${age}\n    ${theme.fg("dim", s.url)}`;
			}
			const content = result.content[0];
			if (content?.type === "text") {
				text += "\n\n" + theme.fg("toolOutput", content.text);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: [
			"Fetch and read a specific non-repository web page or PDF, then return a cited answer.",
			"Implemented via Anthropic's server-side web_fetch tool using",
			`the configured model (default: ${DEFAULT_MODEL}).`,
			"Use for ordinary web pages and PDFs that the user provides or that web_search discovers.",
			"Do not use web_fetch to inspect remote git repository code or documentation on GitHub, GitLab, Bitbucket, or another git host; use the librarian skill to obtain a reusable local checkout, then read or search it locally.",
			"This does not execute client-side JavaScript.",
		].join(" "),
		promptSnippet:
			"Fetch and read a non-repository web page or PDF from a specific URL",
		promptGuidelines: [
			"Do not use web_fetch for remote git repository code or documentation, including repository root, tree, blob, source, README, docs, or raw-file URLs on GitHub, GitLab, Bitbucket, or another git host. Load and follow the librarian skill, obtain or reuse its local checkout, and inspect it with local tools instead. This repository-routing rule takes precedence over the generic instruction to fetch user-provided URLs.",
			"Use web_fetch to inspect a specific non-repository web page or PDF, including URLs returned by web_search. Web-only repository artifacts such as issue or pull-request discussions may use web_fetch when the needed content is not present in the local checkout.",
			"Use the optional focus instruction when only part of a long source is relevant. Cite the returned source URL in your reply.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			const model = DEFAULT_MODEL;
			const focus = params.focus?.trim() || undefined;
			const initialDetails: WebFetchDetails = {
				url: params.url,
				...(focus ? { focus } : {}),
				model,
				fetchedUrls: [],
				sources: [],
				fetchRequests: 0,
				inputTokens: 0,
				outputTokens: 0,
				stopReason: null,
			};

			const body = buildWebFetchRequest({
				url: params.url,
				focus,
				model,
				maxTokens: DEFAULT_MAX_TOKENS,
				maxContentTokens:
					params.max_content_tokens ?? DEFAULT_MAX_CONTENT_TOKENS,
			});

			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${params.url}...` }],
				details: initialDetails,
			});

			let payload: MessagesResponse;
			try {
				payload = await callAnthropic(body, apiKey, signal);
			} catch (error) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Fetch cancelled." }],
						details: { ...initialDetails, stopReason: "cancelled" },
					};
				}
				throw error;
			}

			const { answer, details } = parseWebFetchResponse(payload, {
				url: params.url,
				focus,
				model,
			});

			if (!answer && !details.sources.length) {
				const errText = details.error
					? `Web fetch failed: ${details.error}`
					: "Web fetch returned no content.";
				return {
					content: [{ type: "text", text: errText }],
					details,
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: formatWebFetchResult(answer, details) }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			const url = typeof args.url === "string" ? args.url : "";
			text += theme.fg("accent", url || "...");
			if (typeof args.focus === "string" && args.focus.trim()) {
				text += " " + theme.fg("dim", `(${args.focus.trim()})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			const header =
				theme.fg("success", `✓ ${details.fetchRequests} fetch${details.fetchRequests === 1 ? "" : "es"}`) +
				theme.fg("muted", `, ${details.sources.length} source${details.sources.length === 1 ? "" : "s"}`);

			if (!expanded) {
				let text = header;
				for (const source of details.sources.slice(0, 3)) {
					text += `\n  ${theme.fg("dim", "• ")}${theme.fg("accent", source.title)} ${theme.fg("dim", source.url)}`;
				}
				return new Text(text, 0, 0);
			}

			let text = header;
			text += "\n" + theme.fg("dim", `model=${details.model}  in=${details.inputTokens}  out=${details.outputTokens}`);
			for (const source of details.sources) {
				text += `\n  ${theme.fg("dim", "•")} ${theme.fg("accent", source.title)}\n    ${theme.fg("dim", source.url)}`;
			}
			const content = result.content[0];
			if (content?.type === "text") {
				text += "\n\n" + theme.fg("toolOutput", content.text);
			}
			return new Text(text, 0, 0);
		},
	});
}
