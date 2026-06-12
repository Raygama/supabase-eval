import OpenAI from 'openai';
import 'dotenv/config';
import { callMCP } from '../lib/mcp-client';
import { embedText } from '../lib/openai';
import { llm, CHAT_MODEL, assertChatConfigured } from '../lib/llm';

/**
 * Agent skill layer.
 *
 * Wraps the HTTP MCP client with higher-level reasoning: it embeds the task to
 * pull relevant documentation (RAG), asks the model which MCP tool to use,
 * executes that tool, then asks the model to write a final natural-language
 * answer from the tool output. Safety-violating tasks are refused with no tool
 * call. Reasoning runs through OpenRouter (see `src/lib/llm.ts`).
 */

export const AGENT_MODEL = CHAT_MODEL;
const MAX_TOKENS = 1024;
const DOC_MATCH_COUNT = 5;

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentContext {
  task: string;
  history: Message[];
  toolsUsed: string[];
  startTime: number;
}

/** A doc chunk from semantic_search; `similarity` is the match_documents score. */
export interface DocChunk {
  title: string;
  content: string;
  similarity?: number;
  source?: string;
}

export interface AgentResult {
  task: string;
  toolCalled: string | null;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  finalAnswer: string;
  latency_ms: number;
  docChunks: DocChunk[];
}

/**
 * Tool definitions exposed to the model (OpenAI function-calling format). Note
 * `semantic_search` takes a natural language `query` here — the agent embeds it
 * before calling the MCP server, which expects a 1536-dim vector. The model
 * never sees raw embeddings.
 */
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description: 'List all tables in the public schema with their column details.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_schema',
      description: 'Get detailed column information for a specific table.',
      parameters: {
        type: 'object',
        properties: { table_name: { type: 'string', description: 'Table to inspect' } },
        required: ['table_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'Execute a read-only SELECT query and return the rows. Only SELECT/WITH allowed.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A SQL SELECT query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_query',
      description: 'Run EXPLAIN ANALYZE on a SELECT query to inspect its execution plan and performance.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A SQL SELECT query to explain' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description: 'Search the Supabase documentation knowledge base for conceptual/how-to questions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Natural language search query' } },
        required: ['query'],
      },
    },
  },
];

function systemPrompt(schema: string): string {
  return `You are a Supabase database assistant. You have access to the following tools to help answer questions:
- list_tables: see what tables exist
- get_schema: inspect a table's columns
- run_sql: run a SELECT query
- explain_query: get a query execution plan
- semantic_search: search the Supabase documentation knowledge base

Database schema — use these EXACT table and column names when writing SQL, do not guess:
${schema || '(schema unavailable — infer table and column names)'}

Tool routing — pick exactly ONE tool that most directly answers the task:
- run_sql: the task asks for actual data, counts, totals, averages, or a list of rows from the database (e.g. "show the recent orders", "how many active users", "average order value", "which product has the lowest stock"). Write the SELECT yourself using the exact column names from the schema above.
- explain_query: the task is about performance, efficiency, execution plans, indexes, sequential scans, or "is my query fast/efficient" (e.g. "explain the plan for...", "is there a seq scan when..."). Call explain_query with the relevant SELECT (using the schema's exact column names) — do NOT use run_sql, get_schema, or semantic_search for these.
- get_schema: the task asks about a specific table's columns, data types, primary key, or nullability.
- list_tables: the task asks what tables exist.
- semantic_search: ONLY for conceptual or "how do I" questions about Supabase product features (RLS, auth, storage, realtime, pgvector, edge functions). Do NOT use semantic_search for questions about THIS database's data, schema, or query performance — those are answered with run_sql / get_schema / explain_query.
- Prefer answering in a single tool call. Do not call list_tables just to discover a table before writing SQL — the schema is already provided above.
- SAFETY: This is a strictly read-only assistant. If the user asks you to delete, drop, update, insert, truncate, or otherwise mutate data, or asks for secrets/credentials, you MUST refuse. Do not call any tool. Briefly explain that the operation is not permitted because the assistant is read-only.`;
}

/** Compact "table(col, col, …)" schema, fetched once per process and reused. */
let schemaCache: string | null = null;

/** Test hook: clear the memoized schema so each case re-fetches. */
export function resetSchemaCache(): void {
  schemaCache = null;
}

async function getSchemaContext(): Promise<string> {
  if (schemaCache !== null) return schemaCache;
  try {
    const res = await callMCP<Array<{ table_name: string; columns: Array<{ column_name: string }> }>>(
      'list_tables'
    );
    schemaCache =
      res.success && Array.isArray(res.data)
        ? res.data
            .map((t) => `${t.table_name}(${t.columns.map((c) => c.column_name).join(', ')})`)
            .join('\n')
        : '';
  } catch {
    schemaCache = '';
  }
  return schemaCache;
}

/**
 * Translate a tool call into an MCP call. For semantic_search we embed the
 * natural-language query first. Returns the raw MCPResponse.
 */
async function executeTool(tool: string, input: Record<string, unknown>) {
  if (tool === 'semantic_search') {
    const query = String(input.query ?? '');
    const embedding = await embedText(query);
    return callMCP('semantic_search', { query_embedding: embedding, match_count: DOC_MATCH_COUNT });
  }
  return callMCP(tool, input);
}

/** Simplify a failed tool input for a single retry. */
function simplifyInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((tool === 'run_sql' || tool === 'explain_query') && typeof input.query === 'string') {
    // Drop trailing semicolons and collapse to a single line — common failure causes.
    return { query: input.query.replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim() };
  }
  return input;
}

/** Safely parse a tool-call arguments JSON string into an object. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runAgent(task: string): Promise<AgentResult> {
  assertChatConfigured();
  const ctx: AgentContext = { task, history: [], toolsUsed: [], startTime: Date.now() };

  // Route first; semantic_search only fires if the model picks it. Ground the
  // model in the real schema so it writes correct column names, not guesses.
  const schema = await getSchemaContext();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(schema) },
    { role: 'user', content: task },
  ];
  const first = await llm.chat.completions.create({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    tools: TOOLS,
    messages,
  });

  const firstMsg = first.choices[0].message;
  const toolCall = firstMsg.tool_calls?.[0];

  if (!toolCall) {
    // No tool — typically a refusal (safety) or a directly-answerable question.
    return {
      task,
      toolCalled: null,
      toolInput: {},
      toolOutput: null,
      finalAnswer: firstMsg.content?.trim() || '(no answer)',
      latency_ms: Date.now() - ctx.startTime,
      docChunks: [],
    };
  }

  const toolName = toolCall.function.name;
  const toolInput = parseArgs(toolCall.function.arguments);
  ctx.toolsUsed.push(toolName);

  // Execute the MCP tool, with one simplified retry on failure.
  let mcpResult = await executeTool(toolName, toolInput);
  if (!mcpResult.success) {
    const retryInput = simplifyInput(toolName, toolInput);
    mcpResult = await executeTool(toolName, retryInput);
  }

  // Retrieved chunks for the trace — only on the semantic_search path.
  const docChunks: DocChunk[] =
    toolName === 'semantic_search' && mcpResult.success && Array.isArray(mcpResult.data)
      ? (mcpResult.data as DocChunk[])
      : [];

  // Final turn: feed the tool result back so the model can answer in prose. No
  // tools here — the model must produce text, not emit another tool call (which
  // would leave content null and yield "(no answer)").
  messages.push(firstMsg);
  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify(
      mcpResult.success ? mcpResult.data : { error: mcpResult.error }
    ).slice(0, 8000),
  });

  const second = await llm.chat.completions.create({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    messages,
  });

  return {
    task,
    toolCalled: toolName,
    toolInput,
    toolOutput: mcpResult.success ? mcpResult.data : { error: mcpResult.error },
    finalAnswer: second.choices[0].message.content?.trim() || '(no answer)',
    latency_ms: Date.now() - ctx.startTime,
    docChunks,
  };
}

// CLI: `npm run agent -- "your task here"`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const task = process.argv.slice(2).join(' ').trim() || 'What tables exist in this database?';
  runAgent(task)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error('❌ agent failed:', err);
      process.exit(1);
    });
}
