import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../hooks/memorygraph-bridge.js';

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
