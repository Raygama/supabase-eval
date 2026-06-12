import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callMCP, getMCPManifest } from '../src/lib/mcp-client';

/** callMCP/getMCPManifest with a mocked fetch — no network. */

const okResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body } as Response);

describe('callMCP', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the parsed MCPResponse shape on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ tool: 'run_sql', success: true, data: [{ id: 1 }], latency_ms: 12 })
    );
    const res = await callMCP('run_sql', { query: 'SELECT 1' });
    expect(res).toMatchObject({ tool: 'run_sql', success: true, latency_ms: 12 });
    expect(res.data).toEqual([{ id: 1 }]);
  });

  it('passes through tool-level errors as success:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse(
        { tool: 'run_sql', success: false, error: 'Only SELECT allowed', latency_ms: 3 },
        400
      )
    );
    const res = await callMCP('run_sql', { query: 'DELETE FROM users' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SELECT/);
  });

  it('returns success:false on a network error instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await callMCP('list_tables');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Network error/);
  });

  it('returns success:false on a non-JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const res = await callMCP('list_tables');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Non-JSON/);
  });
});

describe('getMCPManifest', () => {
  it('returns the manifest with tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ name: 'supabase-eval-mcp', version: '1.0.0', tools: [{ name: 'run_sql' }] })
    );
    const manifest = await getMCPManifest();
    expect(manifest.name).toBe('supabase-eval-mcp');
    expect(manifest.tools.map((t) => t.name)).toContain('run_sql');
  });
});
