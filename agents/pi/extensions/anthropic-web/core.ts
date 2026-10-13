export const WEB_SEARCH_TOOL_VERSION = "web_search_20260318";
export const WEB_FETCH_TOOL_VERSION = "web_fetch_20260318";

export function classifyWebSearchToolError(
	errorCode: string,
	hasUsefulResults: boolean,
): { warning?: string; error?: string } {
	const message = `web_search_tool_result_error: ${errorCode}`;
	return errorCode === "max_uses_exceeded" && hasUsefulResults
		? { warning: message }
		: { error: message };
}

export interface BuildWebSearchToolOptions {
	maxUses: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
	userLocation?: unknown;
}

export function buildWebSearchTool(
	options: BuildWebSearchToolOptions,
): Record<string, unknown> {
	const tool: Record<string, unknown> = {
		type: WEB_SEARCH_TOOL_VERSION,
		name: "web_search",
		max_uses: options.maxUses,
		allowed_callers: ["direct"],
		response_inclusion: "full",
	};
	if (options.allowedDomains?.length) {
		tool.allowed_domains = options.allowedDomains;
	}
	if (options.blockedDomains?.length) {
		tool.blocked_domains = options.blockedDomains;
	}
	if (options.userLocation) tool.user_location = options.userLocation;
	return tool;
}

export interface WebFetchSource {
	url: string;
	title: string;
	retrievedAt?: string;
}

export interface WebFetchDetails {
	url: string;
	focus?: string;
	model: string;
	fetchedUrls: string[];
	sources: WebFetchSource[];
	fetchRequests: number;
	inputTokens: number;
	outputTokens: number;
	stopReason: string | null;
	error?: string;
}

export interface BuildWebFetchRequestOptions {
	url: string;
	focus?: string;
	model: string;
	maxTokens: number;
	maxContentTokens: number;
}

export function buildWebFetchRequest(options: BuildWebFetchRequestOptions) {
	const focus = options.focus?.trim();
	const content = focus
		? `Fetch ${options.url} and ${focus}`
		: `Fetch ${options.url} and return a faithful, useful summary of its content.`;

	return {
		model: options.model,
		max_tokens: options.maxTokens,
		messages: [{ role: "user", content }],
		tools: [
			{
				type: WEB_FETCH_TOOL_VERSION,
				name: "web_fetch",
				max_uses: 1,
				citations: { enabled: true },
				max_content_tokens: options.maxContentTokens,
				allowed_callers: ["direct"],
				response_inclusion: "full",
			},
		],
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function* walkRecords(value: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(value)) {
		for (const item of value) yield* walkRecords(item);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	yield record;
	for (const child of Object.values(record)) yield* walkRecords(child);
}

function addSource(
	sources: WebFetchSource[],
	seen: Set<string>,
	url: unknown,
	title: unknown,
	retrievedAt?: unknown,
): void {
	if (typeof url !== "string" || !url || seen.has(url)) return;
	seen.add(url);
	sources.push({
		url,
		title: typeof title === "string" && title ? title : url,
		...(typeof retrievedAt === "string" && retrievedAt
			? { retrievedAt }
			: {}),
	});
}

export function parseWebFetchResponse(
	payload: unknown,
	request: { url: string; focus?: string; model: string },
): { answer: string; details: WebFetchDetails } {
	const root = asRecord(payload) ?? {};
	const blocks = Array.isArray(root.content) ? root.content : [];
	const answerParts: string[] = [];
	const fetchedUrls: string[] = [];
	const sources: WebFetchSource[] = [];
	const seenSources = new Set<string>();
	let error: string | undefined;

	// Only top-level assistant text belongs in the returned answer. Server-tool
	// details may be nested inside code-execution blocks when dynamic filtering runs.
	for (const value of blocks) {
		const block = asRecord(value);
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			answerParts.push(block.text.trim());
		}
	}

	for (const block of walkRecords(blocks)) {
		if (block.type === "web_fetch_result_location") {
			addSource(sources, seenSources, block.url, block.title);
			continue;
		}

		if (block.type === "server_tool_use" && block.name === "web_fetch") {
			const input = asRecord(block.input);
			if (typeof input?.url === "string" && input.url.trim()) {
				fetchedUrls.push(input.url.trim());
			}
			continue;
		}

		if (block.type === "web_fetch_tool_result_error") {
			const code =
				typeof block.error_code === "string" ? block.error_code : "unknown";
			error = `web_fetch_tool_result_error: ${code}`;
			continue;
		}

		if (block.type !== "web_fetch_result") continue;
		const document = asRecord(block.content);
		addSource(
			sources,
			seenSources,
			block.url,
			document?.title,
			block.retrieved_at,
		);
	}

	const usage = asRecord(root.usage);
	const serverToolUse = asRecord(usage?.server_tool_use);
	const details: WebFetchDetails = {
		url: request.url,
		...(request.focus ? { focus: request.focus } : {}),
		model:
			typeof root.model === "string" && root.model ? root.model : request.model,
		fetchedUrls,
		sources,
		fetchRequests:
			typeof serverToolUse?.web_fetch_requests === "number"
				? serverToolUse.web_fetch_requests
				: fetchedUrls.length,
		inputTokens:
			typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
		outputTokens:
			typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
		stopReason:
			typeof root.stop_reason === "string" ? root.stop_reason : null,
		...(error ? { error } : {}),
	};

	return { answer: answerParts.join("\n\n"), details };
}

export function formatWebFetchResult(
	answer: string,
	details: WebFetchDetails,
): string {
	const lines: string[] = [];
	if (answer) lines.push(answer);

	if (details.sources.length > 0) {
		lines.push("", "Sources:");
		details.sources.forEach((source, index) => {
			lines.push(`[${index + 1}] ${source.title} — ${source.url}`);
		});
	}

	lines.push(
		"",
		`[model=${details.model}, fetches=${details.fetchRequests}, in=${details.inputTokens}, out=${details.outputTokens}]`,
	);
	return lines.join("\n").trim();
}
