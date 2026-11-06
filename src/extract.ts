export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUseSummary[];
  toolResults?: ToolResultSummary[];
  handle?: string;
}

export interface ToolUseSummary {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: true;
}

export interface ToolResultSummary {
  tool_use_id: string;
  text: string;
  isError: boolean;
}

export interface ExtractedContext {
  sessionGoal: string;
  activeFiles: string[];
  decisions: string[];
  errors: ErrorContext[];
  taskSummary: string;
  projectPath: string;
}

export interface ErrorContext {
  tool: string;
  error: string;
  resolved: boolean;
}

export interface MemoryEntry {
  type: 'conversation' | 'decision' | 'solution' | 'error' | 'fix' | 'file_context';
  title: string;
  content: string;
  summary: string;
  tags: string[];
  importance: number;
  context: Record<string, unknown>;
}

export interface Relationship {
  fromIndex: number;
  toIndex: number;
  type: string;
  context: string;
  strength: number;
}

export interface MemoryPlan {
  memories: MemoryEntry[];
  relationships: Relationship[];
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|credential|auth)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+]{8,}['"]?/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /Bearer\s+[A-Za-z0-9_\-/.+]{20,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);

function extractFilePath(tool: string, input: Record<string, unknown>): string | undefined {
  if (!FILE_TOOLS.has(tool)) return undefined;
  const v = input['file_path'];
  return typeof v === 'string' ? v : undefined;
}

function extractBashPaths(input: Record<string, unknown>): string[] {
  const command = input['command'] as string | undefined;
  if (!command) return [];
  const paths: string[] = [];
  const matches = command.matchAll(/(?:^|\s)(?:cat|head|tail|less|vim|nano|code|edit)\s+["']?([^\s"'|;&]+)/g);
  for (const m of matches) {
    if (m[1] && m[1].includes('/')) paths.push(m[1]);
  }
  return paths;
}

export function extractActiveFiles(messages: readonly SessionMessage[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    for (const use of msg.toolUses) {
      const path = extractFilePath(use.tool, use.input);
      if (path) files.add(path);
      if (use.tool === 'Bash') {
        for (const p of extractBashPaths(use.input)) files.add(p);
      }
    }
  }
  return [...files].sort();
}

export function extractSessionGoal(messages: readonly SessionMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user' && msg.text.trim().length > 10) {
      const text = msg.text.trim();
      return text.length > 500 ? text.slice(0, 497) + '...' : text;
    }
  }
  return '(no user request found)';
}

export function extractErrors(messages: readonly SessionMessage[]): ErrorContext[] {
  const errors: ErrorContext[] = [];

  for (const msg of messages) {
    for (const use of msg.toolUses) {
      if (use.isError && use.text) {
        errors.push({
          tool: use.tool,
          error: use.text.slice(0, 300),
          resolved: false,
        });
      }
    }
    if (msg.toolResults) {
      for (const result of msg.toolResults) {
        if (result.isError && result.text) {
          errors.push({
            tool: '(result)',
            error: result.text.slice(0, 300),
            resolved: false,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text.length > 20);
    if (lastAssistant) {
      const lower = lastAssistant.text.toLowerCase();
      const fixSignals = ['fixed', 'resolved', 'working now', 'passes', 'all tests pass'];
      if (fixSignals.some(s => lower.includes(s))) {
        for (const e of errors) e.resolved = true;
      }
    }
  }

  return errors;
}

export function extractDecisions(messages: readonly SessionMessage[]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.text.length < 30) continue;
    const lines = msg.text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.match(/^(I'll|Let's|We should|The approach|Going with|Using|Decided to|Plan:)/i) &&
        trimmed.length > 20 &&
        trimmed.length < 300
      ) {
        decisions.push(trimmed);
      }
    }
  }
  return decisions.slice(-10);
}

export function extractTaskSummary(messages: readonly SessionMessage[]): string {
  const assistantMessages = messages.filter(m => m.role === 'assistant' && m.text.length > 50);
  if (assistantMessages.length === 0) return '';
  const last = assistantMessages[assistantMessages.length - 1]!;
  const text = last.text.trim();
  return text.length > 500 ? text.slice(0, 497) + '...' : text;
}

export function extractContext(messages: readonly SessionMessage[], projectPath = ''): ExtractedContext {
  return {
    sessionGoal: extractSessionGoal(messages),
    activeFiles: extractActiveFiles(messages),
    decisions: extractDecisions(messages),
    errors: extractErrors(messages),
    taskSummary: extractTaskSummary(messages),
    projectPath,
  };
}

export function contextToMemories(context: ExtractedContext, importance: number, maxMemories: number): MemoryPlan {
  const memories: MemoryEntry[] = [];
  const relationships: Relationship[] = [];
  const timestamp = new Date().toISOString().slice(0, 19);
  const baseCtx: Record<string, unknown> = { source: 'compaction' };
  if (context.projectPath) baseCtx.projectPath = context.projectPath;

  if (context.sessionGoal === '(no user request found)') {
    return { memories: [], relationships: [] };
  }

  // Memory 0: session context (always first)
  const contentParts = [`Goal: ${context.sessionGoal}`];
  if (context.activeFiles.length > 0) {
    contentParts.push(`Active files: ${context.activeFiles.join(', ')}`);
  }
  if (context.decisions.length > 0) {
    contentParts.push(`Decisions:\n${context.decisions.map(d => `- ${d}`).join('\n')}`);
  }
  if (context.taskSummary) {
    contentParts.push(`Last status: ${context.taskSummary}`);
  }

  memories.push({
    type: 'conversation',
    title: `Session context (${timestamp})`,
    content: redact(contentParts.join('\n\n')),
    summary: context.sessionGoal.length > 200 ? context.sessionGoal.slice(0, 197) + '...' : context.sessionGoal,
    tags: ['compaction', 'session-context'],
    importance,
    context: { ...baseCtx, fileCount: context.activeFiles.length },
  });

  // Decisions (capped at 5, each as its own memory)
  for (const decision of context.decisions.slice(0, 5)) {
    if (memories.length >= maxMemories) break;
    const idx = memories.length;
    memories.push({
      type: 'decision',
      title: decision.length > 80 ? decision.slice(0, 77) + '...' : decision,
      content: redact(decision),
      summary: decision.length > 200 ? decision.slice(0, 197) + '...' : decision,
      tags: ['compaction', 'decision'],
      importance,
      context: { ...baseCtx },
    });
    relationships.push({
      fromIndex: idx,
      toIndex: 0,
      type: 'RELATED_TO',
      context: 'Decision made during this session',
      strength: 0.8,
    });
  }

  // Errors and solutions
  for (const err of context.errors) {
    if (memories.length >= maxMemories) break;
    const idx = memories.length;
    if (err.resolved) {
      memories.push({
        type: 'solution',
        title: `Fixed: ${err.tool} error (${timestamp})`,
        content: `Error in ${err.tool}: ${redact(err.error)}\n\nResolved during this session.`,
        summary: `Resolved ${err.tool} error`,
        tags: ['compaction', 'error-fix', err.tool.toLowerCase()],
        importance: Math.min(1, importance + 0.1),
        context: { ...baseCtx, tool: err.tool },
      });
      relationships.push({
        fromIndex: idx,
        toIndex: 0,
        type: 'SOLVES',
        context: `Resolved ${err.tool} error encountered during session`,
        strength: 0.9,
      });
    } else {
      memories.push({
        type: 'error',
        title: `Unresolved: ${err.tool} error (${timestamp})`,
        content: `Error in ${err.tool}: ${redact(err.error)}\n\nNot yet resolved at compaction time.`,
        summary: `Unresolved ${err.tool} error`,
        tags: ['compaction', 'unresolved', err.tool.toLowerCase()],
        importance: Math.min(1, importance + 0.2),
        context: { ...baseCtx, tool: err.tool },
      });
      relationships.push({
        fromIndex: idx,
        toIndex: 0,
        type: 'RELATED_TO',
        context: `Unresolved ${err.tool} error from session`,
        strength: 0.7,
      });
    }
  }

  // File context (when 3+ files touched)
  if (context.activeFiles.length >= 3 && memories.length < maxMemories) {
    const idx = memories.length;
    memories.push({
      type: 'file_context',
      title: `Files touched (${timestamp})`,
      content: context.activeFiles.join('\n'),
      summary: `${context.activeFiles.length} files touched during session`,
      tags: ['compaction', 'file-context', ...context.activeFiles.slice(0, 5).map(f => f.split('/').pop() ?? f)],
      importance: Math.max(0, importance - 0.1),
      context: { ...baseCtx, fileCount: context.activeFiles.length },
    });
    relationships.push({
      fromIndex: idx,
      toIndex: 0,
      type: 'RELATED_TO',
      context: 'Files active during this session',
      strength: 0.6,
    });
  }

  return { memories: memories.slice(0, maxMemories), relationships };
}
