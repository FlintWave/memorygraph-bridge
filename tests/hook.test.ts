import { describe, expect, it, vi } from 'vitest';
import { resolveConfig, checkServer } from '../hooks/memorygraph-bridge.js';

describe('resolveConfig', () => {
  it('falls back to defaults with empty options', () => {
    expect(resolveConfig({})).toEqual({
      mcpServer: 'memorygraph',
      importance: 0.7,
      maxMemories: 5,
      nudge: true,
      projectPath: '',
    });
  });

  it('reads user config values', () => {
    expect(resolveConfig({
      mcpServer: 'my-graph',
      importance: 0.9,
      maxMemories: 10,
      nudge: false,
      projectPath: '/home/user/project',
    })).toEqual({
      mcpServer: 'my-graph',
      importance: 0.9,
      maxMemories: 10,
      nudge: false,
      projectPath: '/home/user/project',
    });
  });

  it('clamps importance to [0, 1]', () => {
    expect(resolveConfig({ importance: 2.0 }).importance).toBe(1);
    expect(resolveConfig({ importance: -0.5 }).importance).toBe(0);
  });

  it('clamps maxMemories to [1, 20]', () => {
    expect(resolveConfig({ maxMemories: 0 }).maxMemories).toBe(1);
    expect(resolveConfig({ maxMemories: 100 }).maxMemories).toBe(20);
  });

  it('ignores invalid types', () => {
    const config = resolveConfig({
      mcpServer: 42,
      importance: 'high',
      maxMemories: 'five',
      nudge: 'yes',
      projectPath: 123,
    });
    expect(config).toEqual({
      mcpServer: 'memorygraph',
      importance: 0.7,
      maxMemories: 5,
      nudge: true,
      projectPath: '',
    });
  });

  it('defaults projectPath to empty string when not provided', () => {
    expect(resolveConfig({}).projectPath).toBe('');
  });
});

function mockHookContext(callFn: (server: string, tool: string, args?: Record<string, unknown>) => Promise<unknown>) {
  return {
    mcp: { call: callFn },
    ui: { log: vi.fn() },
  };
}

describe('checkServer', () => {
  it('returns true when the server responds to get_recent_activity', async () => {
    const $ = mockHookContext(async () => ({ memories: [] }));
    expect(await checkServer($, 'memorygraph')).toBe(true);
    expect($.ui.log).not.toHaveBeenCalled();
  });

  it('returns false and warns about wrong server when tool is unknown', async () => {
    const $ = mockHookContext(async () => { throw new Error('unknown tool: get_recent_activity'); });
    expect(await checkServer($, 'memory')).toBe(false);
    expect($.ui.log).toHaveBeenCalledOnce();
    expect($.ui.log.mock.calls[0]![0]).toContain("does not support MemoryGraph tools");
    expect($.ui.log.mock.calls[0]![0]).toContain("'memory'");
  });

  it('returns false and warns about unreachable server on other errors', async () => {
    const $ = mockHookContext(async () => { throw new Error('connection refused'); });
    expect(await checkServer($, 'memorygraph')).toBe(false);
    expect($.ui.log).toHaveBeenCalledOnce();
    expect($.ui.log.mock.calls[0]![0]).toContain("could not reach server");
    expect($.ui.log.mock.calls[0]![0]).toContain("claude mcp add");
  });
});
