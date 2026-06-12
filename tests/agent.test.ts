import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Agent unit tests. The chat client (OpenRouter), the MCP client, and the
 * embeddings client are all mocked so the test is deterministic and offline.
 * We verify: (1) the agent wires the model's chosen tool through to the MCP
 * call, and (2) the single retry fires when the first MCP call fails.
 */

const { mockCreate, mockCallMCP, mockEmbed } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCallMCP: vi.fn(),
  mockEmbed: vi.fn(),
}));

vi.mock('../src/lib/llm', () => ({
  llm: { chat: { completions: { create: mockCreate } } },
  CHAT_MODEL: 'test-model',
  assertChatConfigured: () => {},
}));

vi.mock('../src/lib/mcp-client', () => ({ callMCP: mockCallMCP }));
vi.mock('../src/lib/openai', () => ({
  embedText: mockEmbed,
  embedBatch: vi.fn(),
}));

import { runAgent, resetSchemaCache } from '../src/agent';

// OpenAI-style chat-completion response builders.
const toolUseMsg = (name: string, input: Record<string, unknown>) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name, arguments: JSON.stringify(input) } }],
      },
    },
  ],
});
const textMsg = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

beforeEach(() => {
  mockCreate.mockReset();
  mockCallMCP.mockReset();
  mockEmbed.mockReset();
  mockEmbed.mockResolvedValue(new Array(1536).fill(0));
  mockCallMCP.mockResolvedValue({ tool: 'semantic_search', success: true, data: [] });
  // runAgent fetches the schema (list_tables) once and memoizes it — clear between tests.
  resetSchemaCache();
});

describe('runAgent', () => {
  it("routes the model's chosen tool to the MCP client and returns the final answer", async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseMsg('get_schema', { table_name: 'users' }))
      .mockResolvedValueOnce(textMsg('The users table has id, email, full_name.'));
    mockCallMCP
      .mockResolvedValueOnce({ success: true, data: [] }) // schema fetch (list_tables)
      .mockResolvedValueOnce({ success: true, data: [{ column_name: 'email' }] }); // get_schema

    const result = await runAgent('What columns does the users table have?');

    expect(result.toolCalled).toBe('get_schema');
    expect(result.toolInput).toEqual({ table_name: 'users' });
    expect(result.finalAnswer).toMatch(/users table/);
    const toolCalls = mockCallMCP.mock.calls.map((c) => c[0]);
    expect(toolCalls).toContain('get_schema');
  });

  it('fires exactly one retry when the first MCP tool call fails', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseMsg('run_sql', { query: 'SELECT * FROM orders;' }))
      .mockResolvedValueOnce(textMsg('Here are the orders.'));
    mockCallMCP
      .mockResolvedValueOnce({ success: true, data: [] }) // schema fetch (list_tables)
      .mockResolvedValueOnce({ success: false, error: 'syntax error' }) // first attempt
      .mockResolvedValueOnce({ success: true, data: [{ id: 1 }] }); // retry succeeds

    const result = await runAgent('Show me the orders');

    expect(result.toolCalled).toBe('run_sql');
    // run_sql attempted twice (initial + retry); the retry strips the trailing ';'.
    const runSqlCalls = mockCallMCP.mock.calls.filter((c) => c[0] === 'run_sql');
    expect(runSqlCalls.length).toBe(2);
    expect((runSqlCalls[1][1] as { query: string }).query).toBe('SELECT * FROM orders');
  });

  it('refuses (no tool) when the model returns only text', async () => {
    mockCreate.mockResolvedValueOnce(
      textMsg('I cannot do that — this assistant is read-only.')
    );
    const result = await runAgent('Delete all users');
    expect(result.toolCalled).toBeNull();
    expect(result.finalAnswer).toMatch(/read-only/);
  });
});
