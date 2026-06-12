import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MCPRequest {
  tool: string;
  input: Record<string, unknown>;
}

interface MCPResponse {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
  latency_ms: number;
}

interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ─── Tool Definitions (what agents see) ──────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "list_tables",
    description: "List all tables in the public schema with their column details.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_schema",
    description: "Get detailed column information for a specific table including types and constraints.",
    input_schema: {
      type: "object",
      properties: {
        table_name: { type: "string", description: "The name of the table to inspect" }
      },
      required: ["table_name"]
    }
  },
  {
    name: "run_sql",
    description: "Execute a read-only SQL SELECT query against the database. Only SELECT statements are allowed.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A valid SQL SELECT query" }
      },
      required: ["query"]
    }
  },
  {
    name: "explain_query",
    description: "Run EXPLAIN ANALYZE on a SQL query to show its execution plan and performance characteristics.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A valid SQL SELECT query to explain" }
      },
      required: ["query"]
    }
  },
  {
    name: "semantic_search",
    description: "Search the documents table using vector similarity. Returns the most relevant document chunks for a given query embedding.",
    input_schema: {
      type: "object",
      properties: {
        query_embedding: {
          type: "array",
          items: { type: "number" },
          description: "A 1536-dimension embedding vector representing the search query"
        },
        match_count: {
          type: "number",
          description: "Number of results to return (default: 5)"
        }
      },
      required: ["query_embedding"]
    }
  }
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleListTables(supabase: ReturnType<typeof createClient>): Promise<unknown> {
  const { data, error } = await supabase.rpc("list_tables_info");
  if (error) {
    // Fallback: query information_schema directly
    const { data: fallback, error: fallbackError } = await supabase
      .from("information_schema.tables")
      .select("table_name")
      .eq("table_schema", "public");
    if (fallbackError) throw new Error(fallbackError.message);
    return fallback;
  }
  return data;
}

async function handleGetSchema(
  supabase: ReturnType<typeof createClient>,
  input: Record<string, unknown>
): Promise<unknown> {
  const tableName = input.table_name as string;
  if (!tableName) throw new Error("table_name is required");

  const query = `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${tableName.replace(/'/g, "''")}'
    ORDER BY ordinal_position;
  `;

  const { data, error } = await supabase.rpc("execute_readonly_sql", { sql: query });
  if (error) throw new Error(error.message);
  return { table: tableName, columns: data };
}

async function handleRunSQL(
  supabase: ReturnType<typeof createClient>,
  input: Record<string, unknown>
): Promise<unknown> {
  const query = (input.query as string)?.trim();
  if (!query) throw new Error("query is required");

  // Safety: only allow SELECT statements
  const normalized = query.toLowerCase().replace(/\s+/g, " ");
  if (!normalized.startsWith("select") && !normalized.startsWith("with")) {
    throw new Error("Only SELECT (or WITH) queries are allowed for safety.");
  }

  const { data, error } = await supabase.rpc("execute_readonly_sql", { sql: query });
  if (error) throw new Error(error.message);
  return data;
}

async function handleExplainQuery(
  supabase: ReturnType<typeof createClient>,
  input: Record<string, unknown>
): Promise<unknown> {
  const query = (input.query as string)?.trim();
  if (!query) throw new Error("query is required");

  const explainSQL = `EXPLAIN ANALYZE ${query}`;
  const { data, error } = await supabase.rpc("execute_readonly_sql", { sql: explainSQL });
  if (error) throw new Error(error.message);
  return data;
}

async function handleSemanticSearch(
  supabase: ReturnType<typeof createClient>,
  input: Record<string, unknown>
): Promise<unknown> {
  const embedding = input.query_embedding as number[];
  const matchCount = (input.match_count as number) ?? 5;

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("query_embedding must be an array of numbers");
  }
  if (embedding.length !== 1536) {
    throw new Error(`Expected 1536-dim embedding, got ${embedding.length}`);
  }

  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_count: matchCount
  });
  if (error) throw new Error(error.message);
  return data;
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function routeTool(
  supabase: ReturnType<typeof createClient>,
  tool: string,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (tool) {
    case "list_tables":     return handleListTables(supabase);
    case "get_schema":      return handleGetSchema(supabase, input);
    case "run_sql":         return handleRunSQL(supabase, input);
    case "explain_query":   return handleExplainQuery(supabase, input);
    case "semantic_search": return handleSemanticSearch(supabase, input);
    default:
      throw new Error(`Unknown tool: "${tool}". Available tools: ${TOOLS.map(t => t.name).join(", ")}`);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // GET / — return tool manifest (what tools are available)
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ name: "supabase-eval-mcp", version: "1.0.0", tools: TOOLS }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // POST / — execute a tool
  if (req.method === "POST") {
    const start = Date.now();
    let body: MCPRequest;

    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { tool, input = {} } = body;

    if (!tool) {
      return new Response(
        JSON.stringify({ error: '"tool" field is required' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      const data = await routeTool(supabase, tool, input);
      const response: MCPResponse = {
        tool,
        success: true,
        data,
        latency_ms: Date.now() - start
      };
      return new Response(JSON.stringify(response, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      const response: MCPResponse = {
        tool,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start
      };
      return new Response(JSON.stringify(response, null, 2), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
});
