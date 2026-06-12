import 'dotenv/config';

if (!process.env.MCP_SERVER_URL) throw new Error('MCP_SERVER_URL is required');

const MCP_URL = process.env.MCP_SERVER_URL;

/** Mirrors the MCPResponse shape returned by the Edge Function. */
export interface MCPResponse<T = unknown> {
  tool: string;
  success: boolean;
  data?: T;
  error?: string;
  latency_ms: number;
}

/** The manifest returned by GET / on the MCP server. */
export interface MCPTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MCPManifest {
  name: string;
  version: string;
  tools: MCPTool[];
}

/**
 * Call a single MCP tool over HTTP.
 *
 * The Edge Function returns a 400 with `success: false` for tool-level errors
 * (e.g. a rejected non-SELECT query). We never throw on those — we return the
 * parsed body so callers can inspect `success`. We only throw on transport
 * failures (network down, non-JSON body).
 */
export async function callMCP<T = unknown>(
  tool: string,
  input: Record<string, unknown> = {}
): Promise<MCPResponse<T>> {
  let res: Response;
  try {
    res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, input }),
    });
  } catch (err) {
    return {
      tool,
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: 0,
    };
  }

  try {
    return (await res.json()) as MCPResponse<T>;
  } catch {
    return {
      tool,
      success: false,
      error: `Non-JSON response (HTTP ${res.status})`,
      latency_ms: 0,
    };
  }
}

/** Fetch the tool manifest from the MCP server (GET /). */
export async function getMCPManifest(): Promise<MCPManifest> {
  const res = await fetch(MCP_URL);
  return (await res.json()) as MCPManifest;
}
