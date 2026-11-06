import { describe, expect, it } from 'vitest';
import {
  contextToMemories,
  extractActiveFiles,
  extractContext,
  extractDecisions,
  extractErrors,
  extractSessionGoal,
  extractTaskSummary,
  redact,
  type SessionMessage,
} from '../src/extract.js';

function msg(role: 'user' | 'assistant', text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage {
  return { role, text, toolUses };
}

function toolCall(tool: string, input: Record<string, unknown>, text?: string, isError?: true): SessionMessage['toolUses'][number] {
  return { tool_use_id: `id-${Math.random()}`, tool, input, text, isError };
}

function withResults(m: SessionMessage, results: SessionMessage['toolResults']): SessionMessage {
  return { ...m, toolResults: results };
}

describe('extractActiveFiles', () => {
  it('collects unique file paths from Read, Edit, Write tool calls', () => {
    const messages: SessionMessage[] = [
      msg('assistant', '', [
        toolCall('Read', { file_path: '/src/a.ts' }),
        toolCall('Edit', { file_path: '/src/b.ts', old_string: 'x', new_string: 'y' }),
        toolCall('Read', { file_path: '/src/a.ts' }),
      ]),
      msg('assistant', '', [
        toolCall('Write', { file_path: '/src/c.ts', content: 'z' }),
      ]),
    ];
    expect(extractActiveFiles(messages)).toEqual(['/src/a.ts', '/src/b.ts', '/src/c.ts']);
  });

  it('extracts file paths from bash commands', () => {
    const messages: SessionMessage[] = [
      msg('assistant', '', [
        toolCall('Bash', { command: 'cat /etc/config.yaml' }),
      ]),
    ];
    expect(extractActiveFiles(messages)).toEqual(['/etc/config.yaml']);
  });

  it('returns empty array for messages with no file operations', () => {
    const messages: SessionMessage[] = [
      msg('user', 'hello'),
      msg('assistant', 'hi'),
    ];
    expect(extractActiveFiles(messages)).toEqual([]);
  });
});

describe('extractSessionGoal', () => {
  it('returns the first substantial user message', () => {
    const messages: SessionMessage[] = [
      msg('user', 'Fix the failing test in src/auth.ts'),
      msg('assistant', 'On it.'),
    ];
    expect(extractSessionGoal(messages)).toBe('Fix the failing test in src/auth.ts');
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(600);
    const messages: SessionMessage[] = [msg('user', long)];
    const goal = extractSessionGoal(messages);
    expect(goal.length).toBe(500);
    expect(goal.endsWith('...')).toBe(true);
  });

  it('skips very short user messages', () => {
    const messages: SessionMessage[] = [
      msg('user', 'ok'),
      msg('user', 'Build the new auth flow using JWT tokens'),
    ];
    expect(extractSessionGoal(messages)).toBe('Build the new auth flow using JWT tokens');
  });

  it('returns fallback when no substantial user message exists', () => {
    const messages: SessionMessage[] = [msg('assistant', 'hello')];
    expect(extractSessionGoal(messages)).toBe('(no user request found)');
  });
});

describe('extractErrors', () => {
  it('collects errors from tool uses with isError', () => {
    const messages: SessionMessage[] = [
      msg('assistant', '', [
        toolCall('Bash', { command: 'npm test' }, 'FAIL: expected 2 to be 3', true),
      ]),
    ];
    const errors = extractErrors(messages);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.tool).toBe('Bash');
    expect(errors[0]!.error).toContain('FAIL');
    expect(errors[0]!.resolved).toBe(false);
  });

  it('collects errors from tool results', () => {
    const messages: SessionMessage[] = [
      withResults(msg('user', ''), [
        { tool_use_id: 'x', text: 'Command failed with exit code 1', isError: true },
      ]),
    ];
    const errors = extractErrors(messages);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('exit code 1');
  });

  it('marks errors as resolved when the last assistant message signals a fix', () => {
    const messages: SessionMessage[] = [
      msg('assistant', '', [
        toolCall('Bash', { command: 'npm test' }, 'FAIL', true),
      ]),
      msg('assistant', 'Fixed the issue. All tests pass now.'),
    ];
    const errors = extractErrors(messages);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.resolved).toBe(true);
  });
});

describe('extractDecisions', () => {
  it('captures decision-like lines from assistant messages', () => {
    const messages: SessionMessage[] = [
      msg('assistant', "I'll use the chat API instead of systemone for distilled models.\nThis keeps the format consistent."),
      msg('assistant', "Let's go with a direct SQLite write for reliability."),
    ];
    const decisions = extractDecisions(messages);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toContain('chat API');
    expect(decisions[1]).toContain('SQLite');
  });

  it('limits to the last 10 decisions', () => {
    const messages: SessionMessage[] = Array.from({ length: 15 }, (_, i) =>
      msg('assistant', `I'll use approach ${i} for the implementation which is the best way to handle it.`),
    );
    expect(extractDecisions(messages).length).toBeLessThanOrEqual(10);
  });
});

describe('extractTaskSummary', () => {
  it('returns the last substantial assistant message', () => {
    const messages: SessionMessage[] = [
      msg('assistant', 'Starting the implementation of the new feature for the auth module.'),
      msg('assistant', 'The feature is complete. Tests pass and the PR is ready for review.'),
    ];
    expect(extractTaskSummary(messages)).toContain('PR is ready');
  });

  it('returns empty string when no substantial assistant messages exist', () => {
    const messages: SessionMessage[] = [msg('user', 'hello')];
    expect(extractTaskSummary(messages)).toBe('');
  });
});

describe('redact', () => {
  it('redacts API keys', () => {
    expect(redact('api_key=sk-abc123456789012345678901')).toBe('[REDACTED]');
    expect(redact('Set token: "mytoken12345678"')).toBe('Set [REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test')).toBe('Authorization: [REDACTED]');
  });

  it('redacts GitHub PATs', () => {
    expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toBe('[REDACTED]');
  });

  it('leaves normal text unchanged', () => {
    expect(redact('Fixed the auth module bug')).toBe('Fixed the auth module bug');
  });
});

describe('extractContext', () => {
  it('includes projectPath in the context', () => {
    const ctx = extractContext(
      [msg('user', 'Fix the failing tests in the auth module.')],
      '/home/user/project',
    );
    expect(ctx.projectPath).toBe('/home/user/project');
  });

  it('defaults projectPath to empty string', () => {
    const ctx = extractContext([msg('user', 'Fix the failing tests in the auth module.')]);
    expect(ctx.projectPath).toBe('');
  });
});

describe('contextToMemories', () => {
  it('produces a conversation memory as the first entry', () => {
    const context = extractContext([
      msg('user', 'Fix the failing tests in the auth module.'),
      msg('assistant', '', [toolCall('Read', { file_path: '/src/auth.ts' })]),
      msg('assistant', '', [toolCall('Bash', { command: 'npm test' }, 'FAIL', true)]),
      msg('assistant', "I'll use the new token validation approach. Fixed the issue. All tests pass now."),
    ]);
    const plan = contextToMemories(context, 0.7, 5);
    expect(plan.memories.length).toBeGreaterThanOrEqual(1);
    expect(plan.memories[0]!.type).toBe('conversation');
    expect(plan.memories[0]!.title).toContain('Session context');
    expect(plan.memories[0]!.content).toContain('auth');
    expect(plan.memories[0]!.summary).toBeTruthy();
    expect(plan.memories[0]!.tags).toContain('compaction');
    expect(plan.memories[0]!.tags).toContain('session-context');
    expect(plan.memories[0]!.context).toHaveProperty('source', 'compaction');
    expect(plan.memories[0]!.context).toHaveProperty('fileCount');
  });

  it('creates decision memories with RELATED_TO relationships', () => {
    const context = extractContext([
      msg('user', 'Refactor the auth module to use JWT.'),
      msg('assistant', "I'll use the new token validation approach for better security and maintainability."),
    ]);
    const plan = contextToMemories(context, 0.7, 10);
    const decisionMem = plan.memories.find(m => m.type === 'decision');
    expect(decisionMem).toBeDefined();
    expect(decisionMem!.tags).toContain('decision');
    const rel = plan.relationships.find(r => r.type === 'RELATED_TO' && plan.memories[r.fromIndex]?.type === 'decision');
    expect(rel).toBeDefined();
    expect(rel!.toIndex).toBe(0);
  });

  it('creates solution memories with SOLVES relationships for resolved errors', () => {
    const context = {
      sessionGoal: 'Fix tests',
      activeFiles: ['/src/a.ts'],
      decisions: [],
      errors: [{ tool: 'Bash', error: 'FAIL', resolved: true }],
      taskSummary: 'Done',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 5);
    const solutionMem = plan.memories.find(m => m.type === 'solution');
    expect(solutionMem).toBeDefined();
    expect(solutionMem!.title).toContain('Fixed');
    expect(solutionMem!.context).toHaveProperty('tool', 'Bash');
    const rel = plan.relationships.find(r => r.type === 'SOLVES');
    expect(rel).toBeDefined();
    expect(rel!.toIndex).toBe(0);
    expect(rel!.strength).toBe(0.9);
  });

  it('creates error memories with RELATED_TO relationships for unresolved errors', () => {
    const context = {
      sessionGoal: 'Fix tests',
      activeFiles: [],
      decisions: [],
      errors: [{ tool: 'Bash', error: 'FAIL', resolved: false }],
      taskSummary: '',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 5);
    const errorMem = plan.memories.find(m => m.type === 'error');
    expect(errorMem).toBeDefined();
    expect(errorMem!.title).toContain('Unresolved');
    const rel = plan.relationships.find(r => plan.memories[r.fromIndex]?.type === 'error');
    expect(rel).toBeDefined();
    expect(rel!.type).toBe('RELATED_TO');
  });

  it('creates file_context memory when 3+ files are active', () => {
    const context = {
      sessionGoal: 'Refactor components',
      activeFiles: ['/src/a.ts', '/src/b.ts', '/src/c.ts', '/src/d.ts'],
      decisions: [],
      errors: [],
      taskSummary: '',
      projectPath: '/project',
    };
    const plan = contextToMemories(context, 0.7, 10);
    const fileMem = plan.memories.find(m => m.type === 'file_context');
    expect(fileMem).toBeDefined();
    expect(fileMem!.content).toContain('/src/a.ts');
    expect(fileMem!.context).toHaveProperty('projectPath', '/project');
    expect(fileMem!.context).toHaveProperty('fileCount', 4);
  });

  it('does not create file_context memory for fewer than 3 files', () => {
    const context = {
      sessionGoal: 'Small fix',
      activeFiles: ['/src/a.ts', '/src/b.ts'],
      decisions: [],
      errors: [],
      taskSummary: '',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 10);
    expect(plan.memories.find(m => m.type === 'file_context')).toBeUndefined();
  });

  it('includes projectPath in memory context when set', () => {
    const context = {
      sessionGoal: 'Fix tests',
      activeFiles: [],
      decisions: [],
      errors: [],
      taskSummary: '',
      projectPath: '/home/user/project',
    };
    const plan = contextToMemories(context, 0.7, 5);
    expect(plan.memories[0]!.context).toHaveProperty('projectPath', '/home/user/project');
  });

  it('omits projectPath from context when empty', () => {
    const context = {
      sessionGoal: 'Fix tests',
      activeFiles: [],
      decisions: [],
      errors: [],
      taskSummary: '',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 5);
    expect(plan.memories[0]!.context).not.toHaveProperty('projectPath');
  });

  it('respects maxMemories cap', () => {
    const context = {
      sessionGoal: 'Big task',
      activeFiles: ['/a', '/b', '/c', '/d'],
      decisions: ['decision 1', 'decision 2', 'decision 3', 'decision 4', 'decision 5'].map(
        d => `I'll use ${d} for the implementation which is the best way to handle it.`,
      ),
      errors: Array.from({ length: 5 }, (_, i) => ({
        tool: 'Bash',
        error: `Error ${i}`,
        resolved: false,
      })),
      taskSummary: 'In progress',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 3);
    expect(plan.memories.length).toBeLessThanOrEqual(3);
  });

  it('caps decisions at 5 to leave room for other types', () => {
    const context = {
      sessionGoal: 'Large refactor',
      activeFiles: ['/a', '/b', '/c'],
      decisions: Array.from({ length: 10 }, (_, i) =>
        `I'll use approach ${i} for the implementation which is the best way.`,
      ),
      errors: [{ tool: 'Bash', error: 'FAIL', resolved: true }],
      taskSummary: '',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 20);
    const decisionCount = plan.memories.filter(m => m.type === 'decision').length;
    expect(decisionCount).toBeLessThanOrEqual(5);
  });

  it('returns empty plan when there is no session goal', () => {
    const context = {
      sessionGoal: '(no user request found)',
      activeFiles: [],
      decisions: [],
      errors: [],
      taskSummary: '',
      projectPath: '',
    };
    const plan = contextToMemories(context, 0.7, 5);
    expect(plan.memories).toEqual([]);
    expect(plan.relationships).toEqual([]);
  });
});
