import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { callMCP } from '../lib/mcp-client';
import { embedText } from '../lib/openai';

/**
 * Agent skill layer.
 *
 * Wraps the HTTP MCP client with higher-level reasoning: it embeds the task to
 * pull relevant documentation (RAG), asks Claude which MCP tool to use, executes
 * that tool, then asks Claude to write a final natural-language answer from the
 * tool output. Safety-violating tasks are refused by Claude with no tool call.
 */

export const AGENT_MODEL = 'claude-sonnet-4-6';
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

export interface AgentResult {
  task: string;
  toolCalled: string | null;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  finalAnswer: string;
  latency_ms: number;
  docsUsed: number;
}

/**
 * Tool definitions exposed to Claude. Note `semantic_search` takes a natural
 * language `query` here — the agent embeds it before calling the MCP server,
 * which expects a 1536-dim vector. Claude never sees raw embeddings.
 */
const CLAUDE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_tables',
    description: 'List all tables in the public schema with their column details.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_schema',
    description: "Get detailed column information for a specific table.",
    input_schema: {
      type: 'object',
      properties: { table_name: { type: 'string', description: 'Table to inspect' } },
      required: ['table_name'],
    },
  },
  {
    name: 'run_sql',
    description: 'Execute a read-only SELECT query and return the rows. Only SELECT/WITH allowed.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A SQL SELECT query' } },
      required: ['query'],
    },
  },
  {
    name: 'explain_query',
    description: 'Run EXPLAIN ANALYZE on a SELECT query to inspect its execution plan and performance.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A SQL SELECT query to explain' } },
      required: ['query'],
    },
  },
  {
    name: 'semantic_search',
    description: 'Search the Supabase documentation knowledge base for conceptual/how-to questions.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural language search query' } },
      required: ['query'],
    },
  },
];

function lazyAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required to run the agent');
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function systemPrompt(docContext: string): string {
  return `You are a Supabase database assistant. You have access to the following tools to help answer questions:
- list_tables: see what tables exist
- get_schema: inspect a table's columns
- run_sql: run a SELECT query
- explain_query: get a query execution plan
- semantic_search: search documentation

Relevant documentation context:
${docContext || '(no documentation context available)'}

Rules:
- Always use the most specific tool for the task. Only use run_sql when you need actual row data.
- For conceptual or "how do I" questions about Supabase, use semantic_search.
- Use exactly one tool per task when a tool is needed.
- SAFETY: This is a strictly read-only assistant. If the user asks you to delete, drop, update, insert, truncate, or otherwise mutate data, or asks for secrets/credentials, you MUST refuse. Do not call any tool. Briefly explain that the operation is not permitted because the assistant is read-only.`;
}

/**
 * Translate a Claude tool call into an MCP call. For semantic_search we embed
 * the natural-language query first. Returns the raw MCPResponse.
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

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function runAgent(task: string): Promise<AgentResult> {
  const ctx: AgentContext = { task, history: [], toolsUsed: [], startTime: Date.now() };
  const anthropic = lazyAnthropic();

  // 1-3. RAG pre-fetch: embed the task and pull doc context (best-effort).
  let docContext = '';
  let docsUsed = 0;
  try {
    const embedding = await embedText(task);
    const res = await callMCP<Array<{ title: string; content: string }>>('semantic_search', {
      query_embedding: embedding,
      match_count: DOC_MATCH_COUNT,
    });
    if (res.success && Array.isArray(res.data)) {
      docsUsed = res.data.length;
      docContext = res.data.map((d) => `- ${d.title}: ${d.content}`).join('\n');
    }
  } catch {
    // OpenAI/MCP unavailable — proceed without doc context.
  }

  // 4. Ask Claude which tool to use.
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }];
  const first = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt(docContext),
    tools: CLAUDE_TOOLS,
    messages,
  });

  // 5. Parse tool use.
  const toolUse = first.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolUse) {
    // No tool — typically a refusal (safety) or a directly-answerable question.
    return {
      task,
      toolCalled: null,
      toolInput: {},
      toolOutput: null,
      finalAnswer: textOf(first) || '(no answer)',
      latency_ms: Date.now() - ctx.startTime,
      docsUsed,
    };
  }

  const toolName = toolUse.name;
  const toolInput = toolUse.input as Record<string, unknown>;
  ctx.toolsUsed.push(toolName);

  // 6. Execute the MCP tool, with one simplified retry on failure.
  let mcpResult = await executeTool(toolName, toolInput);
  if (!mcpResult.success) {
    const retryInput = simplifyInput(toolName, toolInput);
    mcpResult = await executeTool(toolName, retryInput);
  }

  // Final turn: feed the tool result back so Claude can answer in prose.
  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(
          mcpResult.success ? mcpResult.data : { error: mcpResult.error }
        ).slice(0, 8000),
        is_error: !mcpResult.success,
      },
    ],
  });

  const second = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt(docContext),
    tools: CLAUDE_TOOLS,
    messages,
  });

  return {
    task,
    toolCalled: toolName,
    toolInput,
    toolOutput: mcpResult.success ? mcpResult.data : { error: mcpResult.error },
    finalAnswer: textOf(second) || '(no answer)',
    latency_ms: Date.now() - ctx.startTime,
    docsUsed,
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
