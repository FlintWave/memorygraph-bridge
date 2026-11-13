import { contextToMemories, extractContext } from '../src/extract.js';
import type { MemoryEntry, MemoryPlan, Relationship } from '../src/extract.js';
import type { On, PluginOptions, Register, SessionMessage } from 'claude-code';

export interface BridgeConfig {
  mcpServer: string;
  importance: number;
  maxMemories: number;
  nudge: boolean;
  projectPath: string;
}

const DEFAULTS: BridgeConfig = {
  mcpServer: 'memorygraph',
  importance: 0.7,
  maxMemories: 5,
  nudge: true,
  projectPath: '',
};

export function resolveConfig(options: PluginOptions): BridgeConfig {
  const str = (key: string, fallback: string): string => {
    const v = options[key];
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const v = options[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = options[key];
    return typeof v === 'boolean' ? v : fallback;
  };
  return {
    mcpServer: str('mcpServer', DEFAULTS.mcpServer),
    importance: Math.max(0, Math.min(1, num('importance', DEFAULTS.importance))),
    maxMemories: Math.max(1, Math.min(20, num('maxMemories', DEFAULTS.maxMemories))),
    nudge: bool('nudge', DEFAULTS.nudge),
    projectPath: str('projectPath', DEFAULTS.projectPath),
  };
}

interface HookContext {
  mcp: {
    call: (server: string, tool: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  ui: {
    log: (text: string) => void;
  };
}

async function storeMemory(
  $: HookContext,
  server: string,
  memory: MemoryEntry,
): Promise<string | null> {
  try {
    const result = await $.mcp.call(server, 'store_memory', {
      type: memory.type,
      title: memory.title,
      content: memory.content,
      summary: memory.summary,
      tags: memory.tags,
      importance: memory.importance,
      context: memory.context,
    });
    const obj = result as Record<string, unknown> | null;
    const memoryId = obj?.memory_id;
    return typeof memoryId === 'string' ? memoryId : null;
  } catch (err) {
    $.ui.log(`memorygraph-bridge: failed to store "${memory.title}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function createRelationship(
  $: HookContext,
  server: string,
  fromId: string,
  toId: string,
  rel: { type: string; context: string; strength: number },
): Promise<boolean> {
  try {
    await $.mcp.call(server, 'create_relationship', {
      from_memory_id: fromId,
      to_memory_id: toId,
      relationship_type: rel.type,
      strength: rel.strength,
      context: rel.context,
    });
    return true;
  } catch (err) {
    $.ui.log(`memorygraph-bridge: failed to create relationship: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function checkServer($: HookContext, server: string): Promise<boolean> {
  try {
    await $.mcp.call(server, 'get_recent_activity', { limit: 1 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isWrongServer = /unknown tool|not found|no such tool/i.test(msg);
    if (isWrongServer) {
      $.ui.log(
        `memorygraph-bridge: server '${server}' does not support MemoryGraph tools. ` +
        `Expected tools: store_memory, create_relationship. ` +
        `Check your mcpServer config in ~/.claude/settings.json — it should point to a MemoryGraph server (default: 'memorygraph').`,
      );
    } else {
      $.ui.log(
        `memorygraph-bridge: could not reach server '${server}': ${msg}. ` +
        `Is the MemoryGraph MCP server registered? Run: claude mcp add memorygraph memorygraph`,
      );
    }
    return false;
  }
}

const NUDGE_TEXT =
  '[memorygraph-bridge] Context was stored in MemoryGraph before compaction. ' +
  'Use recall_memories to reload relevant context if needed.';

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveConfig(options);
  let serverChecked = false;
  let serverOk = false;

  on('session.compact', async ($, event, next) => {
    const result = await next(event);
    if ('skip' in result && result.skip) return result;

    if (!serverChecked) {
      serverChecked = true;
      serverOk = await checkServer($, config.mcpServer);
    }
    if (!serverOk) return result;

    const messages = event.messages as readonly SessionMessage[];
    if (messages.length < 4) return result;

    const context = extractContext(messages, config.projectPath);
    const plan: MemoryPlan = contextToMemories(context, config.importance, config.maxMemories);

    if (plan.memories.length === 0) return result;

    const storedIds: (string | null)[] = [];
    for (const memory of plan.memories) {
      const id = await storeMemory($, config.mcpServer, memory);
      storedIds.push(id);
    }

    const storedCount = storedIds.filter(Boolean).length;
    if (storedCount > 0) {
      $.ui.log(`memorygraph-bridge: stored ${storedCount}/${plan.memories.length} memories in MemoryGraph`);
    }

    let relCount = 0;
    for (const rel of plan.relationships) {
      const fromId = storedIds[rel.fromIndex];
      const toId = storedIds[rel.toIndex];
      if (fromId && toId) {
        const ok = await createRelationship($, config.mcpServer, fromId, toId, {
          type: rel.type,
          context: rel.context,
          strength: rel.strength,
        });
        if (ok) relCount++;
      }
    }

    if (relCount > 0) {
      $.ui.log(`memorygraph-bridge: created ${relCount} relationships`);
    }

    if (config.nudge && storedCount > 0 && 'messages' in result && result.messages) {
      const compactedMessages = [...result.messages];
      compactedMessages.push({
        role: 'user' as const,
        text: NUDGE_TEXT,
        toolUses: [],
      } as SessionMessage);
      return { ...result, messages: compactedMessages };
    }

    return result;
  });
};
