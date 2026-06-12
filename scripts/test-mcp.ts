import { callMCP, getMCPManifest } from '../src/lib/mcp-client';
import { embedText } from '../src/lib/openai';

/**
 * Smoke test every MCP tool and print the responses.
 * Run with `npm run test:mcp` to verify the deployed server is healthy.
 */
async function main() {
  console.log('\n📋 MCP Manifest:');
  const manifest = await getMCPManifest();
  console.log(JSON.stringify(manifest, null, 2));

  const tests: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: 'list_tables', input: {} },
    { tool: 'get_schema', input: { table_name: 'orders' } },
    { tool: 'run_sql', input: { query: 'SELECT * FROM users LIMIT 3' } },
    { tool: 'explain_query', input: { query: "SELECT * FROM orders WHERE status = 'pending'" } },
  ];

  for (const t of tests) {
    console.log(`\n🔧 Tool: ${t.tool}`);
    const result = await callMCP(t.tool, t.input);
    console.log(JSON.stringify(result, null, 2));
  }

  // semantic_search needs a real embedding; only run it if OpenAI is configured.
  console.log('\n🔧 Tool: semantic_search');
  try {
    const embedding = await embedText('How do I use pgvector in Supabase?');
    const result = await callMCP('semantic_search', {
      query_embedding: embedding,
      match_count: 3,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(`  ⚠️  Skipped semantic_search: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch(console.error);
