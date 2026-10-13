# Anthropic web tools

Provides web access through Anthropic's hosted tools:

- `web_search` searches and synthesizes an answer with source URLs. It supports
  domain filters, approximate location, and a search-use limit.
- `web_fetch` reads a web page or PDF and returns a cited answer. It accepts an
  extraction focus and content limit. The hosted fetch does not execute JavaScript.

Repository code and documentation use the Librarian skill's local checkout workflow.
Web fetch also supports issue or pull-request discussions when the needed material
is available only on the web.

## Authentication

Configure Anthropic API access in Pi. The extension resolves credentials through
Pi's provider registry. Hosted tools require eligible API credentials; subscription
credentials may not grant access.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `PI_ANTHROPIC_WEB_MODEL` | Model for both tools |
| `PI_WEB_SEARCH_MAX_USES` | Default search-use limit |
| `PI_WEB_FETCH_MAX_CONTENT_TOKENS` | Default fetched-content limit |
| `PI_ANTHROPIC_WEB_TIMEOUT_MS` | Per-call timeout, including continuations |

[`index.ts`](index.ts) defines defaults and tool argument schemas.
[`core.ts`](core.ts) specifies the hosted-tool versions and direct-call request format.

Provider documentation:

- [Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)

## Development

Run the repository's [extension checks](../../../../README.md#validation).
Restart Pi or run `/reload` after changing the extension.
