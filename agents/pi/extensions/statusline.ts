import { basename } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SEPARATOR = "  ";
const PR_REFRESH_MS = 60_000;

interface GhPullRequest {
	number: number;
	state?: string;
	reviewDecision?: string;
	isDraft?: boolean;
}

interface PullRequest {
	number: number;
	status: string;
}

interface SessionMetrics {
	cost: number;
	cacheHitRate: number | null;
}

function sanitize(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	const millions = tokens / 1_000_000;
	return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
}

function formatPrStatus(pr: GhPullRequest): string {
	if (pr.isDraft) return "draft";

	switch (pr.state?.toUpperCase()) {
		case "MERGED":
			return "merged";
		case "CLOSED":
			return "closed";
	}

	switch (pr.reviewDecision?.toUpperCase()) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes requested";
		case "REVIEW_REQUIRED":
			return "pending";
		default:
			return "pending";
	}
}

function parsePullRequest(stdout: string): PullRequest | null {
	try {
		const value = JSON.parse(stdout) as GhPullRequest;
		if (!Number.isInteger(value.number) || value.number <= 0) return null;
		return { number: value.number, status: formatPrStatus(value) };
	} catch {
		return null;
	}
}

function getSessionMetrics(ctx: ExtensionContext): SessionMetrics {
	let cost = 0;
	let hasCacheActivity = false;
	let latestCacheHitRate: number | null = null;

	const addUsage = (usage: Usage) => {
		cost += usage.cost.total || 0;
		hasCacheActivity ||= usage.cacheRead > 0 || usage.cacheWrite > 0;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsage(entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			const usage = message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null;
			addUsage(usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			const usage = (entry.message as ToolResultMessage).usage;
			if (usage) addUsage(usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(entry.usage);
		}
	}

	return {
		cost: Number.isFinite(cost) ? cost : 0,
		cacheHitRate: hasCacheActivity ? latestCacheHitRate : null,
	};
}

function compactDirectory(directory: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(directory) <= width) return directory;

	const leaf = basename(directory);
	const compact = `…/${leaf}`;
	return truncateToWidth(compact, width, "");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			let pullRequest: PullRequest | null = null;
			let refreshGeneration = 0;
			let disposed = false;

			const refreshPullRequest = async (clearFirst = false) => {
				const generation = ++refreshGeneration;
				const branch = footerData.getGitBranch();

				if (clearFirst) {
					pullRequest = null;
					tui.requestRender();
				}
				if (!branch || branch === "detached") return;

				const result = await pi
					.exec(
						"gh",
						["pr", "view", "--json", "number,state,reviewDecision,isDraft"],
						{ cwd: ctx.cwd, timeout: 5_000 },
					)
					.catch(() => undefined);

				if (disposed || generation !== refreshGeneration || !result || result.code !== 0) return;
				pullRequest = parsePullRequest(result.stdout);
				tui.requestRender();
			};

			void refreshPullRequest(true);
			const unsubscribeBranch = footerData.onBranchChange(() => void refreshPullRequest(true));
			const refreshTimer = setInterval(() => void refreshPullRequest(), PR_REFRESH_MS);

			return {
				dispose() {
					disposed = true;
					refreshGeneration++;
					clearInterval(refreshTimer);
					unsubscribeBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];

					const branch = footerData.getGitBranch();
					const modelName = sanitize(ctx.model?.name || ctx.model?.id || "no model");
					const effort = pi.getThinkingLevel();
					const context = ctx.getContextUsage();
					const contextTokens = context?.tokens ?? null;
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const tokenText = `${contextTokens === null ? "-" : formatTokens(contextTokens)}/${
						contextWindow > 0 ? formatTokens(contextWindow) : "-"
					}`;
					const tokenColor =
						contextTokens !== null && contextTokens >= 200_000
							? "error"
							: contextTokens !== null && contextTokens >= 100_000
								? "warning"
								: "muted";
					const metrics = getSessionMetrics(ctx);

					const trailingSegments = [
						...(branch ? [theme.fg("success", sanitize(branch))] : []),
						...(pullRequest
							? [theme.fg("dim", `PR #${pullRequest.number} (${pullRequest.status})`)]
							: []),
						theme.fg("muted", `${modelName} (${effort})`),
						theme.fg(tokenColor, tokenText),
						...(metrics.cacheHitRate !== null
							? [theme.fg("muted", `CH${metrics.cacheHitRate.toFixed(1)}%`)]
							: []),
						theme.fg("muted", `$${metrics.cost.toFixed(3)}`),
					];
					const trailing = trailingSegments.join(SEPARATOR);
					const directoryWidth = Math.max(1, width - visibleWidth(trailing) - SEPARATOR.length);
					const directory = compactDirectory(sanitize(ctx.cwd), directoryWidth);
					const line = theme.fg("accent", directory) + SEPARATOR + trailing;

					return [truncateToWidth(line, width, theme.fg("dim", "…"))];
				},
			};
		});
	});
}
