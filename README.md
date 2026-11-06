# memorygraph-bridge

A Claude Code plugin that saves conversation context to [MemoryGraph](https://memorygraph.dev) before compaction, so agents can recall it afterward.

MemoryGraph is a graph-based persistent memory server for AI coding agents. This plugin hooks into Claude Code's compaction lifecycle to extract session context and store it as linked memories in your local MemoryGraph instance.

## What it does

When Claude Code compacts a conversation (automatically or via `/compact`), this plugin:

1. Lets the compaction run (works alongside other plugins like [Metzger](https://github.com/FlintWave/metzger))
2. Extracts key context from the messages about to be compacted
3. Stores structured memories in MemoryGraph via the MCP server
4. Links related memories with typed relationships using `create_relationship`
5. Optionally nudges the agent to recall what was stored

### Memory types

The plugin uses MemoryGraph's native type system:

| Type | When | Relationship |
| --- | --- | --- |
| `conversation` | Every compaction — session goal, active files, decisions, last status | Root memory |
| `decision` | Each approach the assistant committed to | `RELATED_TO` → session |
| `solution` | Errors that were resolved during the session | `SOLVES` → session |
| `error` | Errors still unresolved at compaction time | `RELATED_TO` → session |
| `file_context` | When 3+ files were touched | `RELATED_TO` → session |

Every memory carries structured `context` metadata (source, project path, tool name, file count) so you can filter and scope recall later.

### Graph structure

```
  [decision] ──RELATED_TO──▶ [conversation] ◀──SOLVES── [solution]
  [decision] ──RELATED_TO──┘       ▲
                                   │
  [file_context] ──RELATED_TO──────┘
  [error] ──────RELATED_TO─────────┘
```

After compaction, the agent (or a future session) can use `recall_memories` or `search_memories` to reload what it needs. MemoryGraph's `project_path` filter scopes recall to the current project.

## Requirements

You need [MemoryGraph](https://memorygraph.dev) running as an MCP server in Claude Code:

```sh
# Install via pipx (recommended)
pipx install 'memorygraphmcp<2'

# Register as an MCP server
claude mcp add memorygraph memorygraph
```

See the [MemoryGraph docs](https://memorygraph.dev/docs/) for backend options (SQLite, Neo4j, FalkorDB, Turso, cloud).

## Install

```sh
claude plugin install memorygraph-bridge@memorygraph-bridge
```

## Options

Set these in `~/.claude/settings.json` under `pluginConfigs.memorygraph-bridge`:

| Option | Default | What it does |
| --- | --- | --- |
| `mcpServer` | `memorygraph` | Name of the MemoryGraph MCP server as registered in Claude Code |
| `importance` | `0.7` | Importance score (0.0–1.0) for stored memories |
| `maxMemories` | `5` | Cap on memories stored per compaction |
| `nudge` | `true` | Append a reminder after compaction telling the agent to check MemoryGraph |
| `projectPath` | `""` | Working directory attached as context metadata for project-scoped recall |

## Companion plugins

[Metzger](https://github.com/FlintWave/metzger) replaces Claude Code's default compaction summarizer with a local scoring model that keeps important tool calls verbatim and cuts the rest. The two plugins work together: Metzger handles what stays in context, memorygraph-bridge handles what gets saved externally to MemoryGraph.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT
