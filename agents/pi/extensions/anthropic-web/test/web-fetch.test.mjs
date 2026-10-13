import assert from "node:assert/strict";
import test from "node:test";

import {
	WEB_FETCH_TOOL_VERSION,
	WEB_SEARCH_TOOL_VERSION,
	buildWebFetchRequest,
	buildWebSearchTool,
	classifyWebSearchToolError,
	formatWebFetchResult,
	parseWebFetchResponse,
} from "../core.ts";

test("builds the latest web search tool in direct-call mode", () => {
	assert.equal(WEB_SEARCH_TOOL_VERSION, "web_search_20260318");
	assert.deepEqual(
		buildWebSearchTool({
			maxUses: 8,
			allowedDomains: ["example.com"],
			userLocation: { type: "approximate", country: "US" },
		}),
		{
			type: "web_search_20260318",
			name: "web_search",
			max_uses: 8,
			allowed_callers: ["direct"],
			response_inclusion: "full",
			allowed_domains: ["example.com"],
			user_location: { type: "approximate", country: "US" },
		},
	);
});

test("treats max_uses_exceeded as a warning after useful search results", () => {
	assert.deepEqual(classifyWebSearchToolError("max_uses_exceeded", true), {
		warning: "web_search_tool_result_error: max_uses_exceeded",
	});
	assert.deepEqual(classifyWebSearchToolError("max_uses_exceeded", false), {
		error: "web_search_tool_result_error: max_uses_exceeded",
	});
	assert.deepEqual(classifyWebSearchToolError("unavailable", true), {
		error: "web_search_tool_result_error: unavailable",
	});
});

test("builds a Sonnet 5 request with the latest web fetch tool", () => {
	const body = buildWebFetchRequest({
		url: "https://example.com/report.pdf",
		focus: "extract the conclusions",
		model: "claude-sonnet-5",
		maxTokens: 4096,
		maxContentTokens: 50_000,
	});

	assert.equal(WEB_FETCH_TOOL_VERSION, "web_fetch_20260318");
	assert.equal(body.model, "claude-sonnet-5");
	assert.deepEqual(body.messages, [
		{
			role: "user",
			content:
				"Fetch https://example.com/report.pdf and extract the conclusions",
		},
	]);
	assert.deepEqual(body.tools, [
		{
			type: "web_fetch_20260318",
			name: "web_fetch",
			max_uses: 1,
			citations: { enabled: true },
			max_content_tokens: 50_000,
			allowed_callers: ["direct"],
			response_inclusion: "full",
		},
	]);
});

test("parses cited results nested by dynamic filtering", () => {
	const payload = {
		model: "claude-sonnet-5",
		stop_reason: "end_turn",
		content: [
			{
				type: "text",
				text: "The report concludes that the project is viable.",
				citations: [
					{
						type: "web_fetch_result_location",
						url: "https://example.com/report.pdf",
						title: "Project report",
					},
				],
			},
			{
				type: "code_execution_tool_result",
				content: [
					{
						type: "server_tool_use",
						name: "web_fetch",
						input: { url: "https://example.com/report.pdf" },
					},
					{
						type: "web_fetch_tool_result",
						content: {
							type: "web_fetch_result",
							url: "https://example.com/report.pdf",
							retrieved_at: "2026-08-01T00:00:00Z",
							content: { title: "Project report" },
						},
					},
				],
			},
		],
		usage: {
			input_tokens: 1200,
			output_tokens: 80,
			server_tool_use: { web_fetch_requests: 1 },
		},
	};

	const { answer, details } = parseWebFetchResponse(payload, {
		url: "https://example.com/report.pdf",
		focus: "extract the conclusions",
		model: "claude-sonnet-5",
	});

	assert.equal(answer, "The report concludes that the project is viable.");
	assert.deepEqual(details.fetchedUrls, ["https://example.com/report.pdf"]);
	assert.deepEqual(details.sources, [
		{ url: "https://example.com/report.pdf", title: "Project report" },
	]);
	assert.equal(details.fetchRequests, 1);
	assert.equal(details.inputTokens, 1200);
	assert.equal(details.outputTokens, 80);
	assert.match(formatWebFetchResult(answer, details), /Project report — https:\/\/example\.com\/report\.pdf/);
});

test("surfaces provider fetch errors", () => {
	const { answer, details } = parseWebFetchResponse(
		{
			model: "claude-sonnet-5",
			stop_reason: "end_turn",
			content: [
				{
					type: "web_fetch_tool_result",
					content: {
						type: "web_fetch_tool_result_error",
						error_code: "url_not_accessible",
					},
				},
			],
		},
		{ url: "https://example.com/private", model: "claude-sonnet-5" },
	);

	assert.equal(answer, "");
	assert.equal(
		details.error,
		"web_fetch_tool_result_error: url_not_accessible",
	);
});
