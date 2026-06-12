import { supabase } from '../src/lib/supabase';
import { embedBatch } from '../src/lib/openai';
import 'dotenv/config';

/**
 * Fetch a set of Supabase docs, chunk + clean them, embed via OpenAI, and
 * store the vectors in the `documents` table. Powers the `semantic_search`
 * MCP tool. Run with `npm run embed:docs` (~$0.02 total).
 */

const DOC_SOURCES = [
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/overview.mdx', title: 'Database Overview' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth.mdx', title: 'Auth Overview' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/quickstart.mdx', title: 'Edge Functions Quickstart' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/ai/vector-columns.mdx', title: 'Vector Columns' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/ai/semantic-search.mdx', title: 'Semantic Search' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/storage/quickstart.mdx', title: 'Storage Quickstart' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/realtime/concepts.mdx', title: 'Realtime Concepts' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/realtime/postgres-changes.mdx', title: 'Realtime Postgres Changes' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/postgres/row-level-security.mdx', title: 'Row Level Security' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/functions.mdx', title: 'Database Functions' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx', title: 'HNSW Indexes' },
  { url: 'https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/social-login.mdx', title: 'Auth Social Login' },
];

/**
 * Fallback static docs. The GitHub doc layout shifts over time and some raw
 * URLs may 404; this guarantees the `documents` table always has rich, on-topic
 * content so semantic_search (and the doc-retrieval evals) work regardless.
 */
const FALLBACK_DOCS = [
  {
    title: 'Row Level Security',
    source: 'fallback://rls',
    content: `Row Level Security (RLS) in Supabase lets you control which rows a user can access in a table. You enable it with ALTER TABLE your_table ENABLE ROW LEVEL SECURITY. Once enabled, all access is denied by default until you add policies. A policy is created with CREATE POLICY ... ON your_table FOR SELECT USING (auth.uid() = user_id). Policies can target SELECT, INSERT, UPDATE, or DELETE. The auth.uid() function returns the ID of the currently authenticated user, which is the most common way to scope rows to their owner. RLS is the primary authorization mechanism in Supabase and should be enabled on every table that holds user data.`,
  },
  {
    title: 'Vector Columns and pgvector',
    source: 'fallback://pgvector',
    content: `pgvector is a Postgres extension that adds a vector data type and similarity search to Supabase. Enable it with create extension vector. You store embeddings in a column of type vector(1536) where 1536 is the embedding dimension produced by a model such as OpenAI text-embedding-3-small. To search, you compare a query embedding against stored vectors using cosine distance with the <=> operator, ordering by embedding <=> query_embedding. For performance you add an HNSW or IVFFlat index on the vector column. pgvector powers semantic search, retrieval augmented generation, and recommendation features directly inside your database.`,
  },
  {
    title: 'Edge Functions Quickstart',
    source: 'fallback://functions',
    content: `Supabase Edge Functions are server-side TypeScript functions that run on Deno, distributed globally at the edge. Create one with supabase functions new my-function, which scaffolds an index.ts. The handler uses Deno.serve to respond to HTTP requests. Deploy with supabase functions deploy my-function. Functions automatically receive SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as environment variables, so you can create a Supabase client inside the function. Use functions for webhooks, custom APIs, and integrations that need secrets that should never reach the browser.`,
  },
  {
    title: 'Auth Overview',
    source: 'fallback://auth',
    content: `Supabase Auth provides user authentication with email and password, magic links, and social OAuth providers including Google, GitHub, Apple, Azure, GitLab, and many more. It issues JWTs that integrate directly with Row Level Security via the auth.uid() function. You sign users in from the client with supabase.auth.signInWithPassword or supabase.auth.signInWithOAuth. Sessions are managed automatically and refreshed in the background. Auth is built on the open-source GoTrue server and stores users in the auth.users table.`,
  },
  {
    title: 'Realtime Quickstart',
    source: 'fallback://realtime',
    content: `Supabase Realtime lets clients subscribe to database changes over websockets. There are three features: Postgres Changes streams inserts, updates, and deletes from your tables; Broadcast sends ephemeral low-latency messages between clients; and Presence tracks which users are currently online. You subscribe with supabase.channel('room').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, handler).subscribe(). Realtime is ideal for chat, live dashboards, multiplayer cursors, and collaborative apps.`,
  },
  {
    title: 'Storage Quickstart',
    source: 'fallback://storage',
    content: `Supabase Storage lets you store and serve files such as images, videos, and documents. Files live in buckets, which can be public or private. Create a bucket from the dashboard or with supabase.storage.createBucket. Upload a file with supabase.storage.from('avatars').upload(path, file) and retrieve it with getPublicUrl for public buckets or createSignedUrl for private ones. Access to storage objects is controlled with the same Row Level Security policies used for database tables, so you can restrict uploads and downloads per user.`,
  },
  {
    title: 'Database Overview',
    source: 'fallback://database',
    content: `Every Supabase project is backed by a full Postgres database. You get the complete power of Postgres including foreign keys, constraints, triggers, views, functions, and extensions. You can connect with any Postgres client, the auto-generated REST API (PostgREST), the client libraries, or GraphQL. Migrations let you version schema changes. Because it is just Postgres, you can use indexes for performance, EXPLAIN ANALYZE to inspect query plans, and database functions to enforce logic close to the data.`,
  },
];

// Split text into ~500 token chunks with 50 token overlap (rough char heuristic).
function chunkText(text: string, chunkSize = 1200, overlap = 150): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }
  return chunks.filter((c) => c.length > 100);
}

// Strip MDX/markdown syntax for cleaner embeddings.
function cleanMarkdown(text: string): string {
  return text
    .replace(/^---[\s\S]*?---/m, '')          // strip frontmatter
    .replace(/import\s+.*?from\s+.*$/gm, '')  // strip MDX imports
    .replace(/<[^>]+>/g, '')                  // strip JSX tags
    .replace(/```[\s\S]*?```/g, '')           // remove code blocks
    .replace(/`[^`]*`/g, '')                  // remove inline code
    // Markdown tables: drop |---| separator rows, then flatten data rows to text.
    .replace(/^\s*\|?[\s:|]*-{2,}[-\s:|]*\|?\s*$/gm, '')
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
      row.split('|').map((cell) => cell.trim()).filter(Boolean).join(' — ')
    )
    .replace(/#{1,6}\s/g, '')                 // remove heading markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text only
    .replace(/^\s*[-*>]\s/gm, '')             // remove bullets/blockquotes
    .replace(/\n{3,}/g, '\n\n')               // collapse whitespace
    .trim();
}

interface PreparedDoc {
  title: string;
  source: string;
  chunks: string[];
}

async function fetchDoc(source: { url: string; title: string }): Promise<PreparedDoc | null> {
  try {
    const res = await fetch(source.url);
    if (!res.ok) {
      console.warn(`  ⚠️  ${source.title}: skipped (HTTP ${res.status})`);
      return null;
    }
    const raw = await res.text();
    const chunks = chunkText(cleanMarkdown(raw));
    if (chunks.length === 0) {
      console.warn(`  ⚠️  ${source.title}: no usable chunks`);
      return null;
    }
    return { title: source.title, source: source.url, chunks };
  } catch (e) {
    console.warn(`  ⚠️  ${source.title}: failed to fetch (${e})`);
    return null;
  }
}

async function main() {
  console.log('🚀 Starting doc embedding pipeline...\n');

  // Clear existing docs so re-runs don't pile up duplicates.
  const { error: delErr } = await supabase.from('documents').delete().not('id', 'is', null);
  if (delErr) throw new Error(`Failed to clear documents: ${delErr.message}`);

  // Fetch all live docs.
  const prepared: PreparedDoc[] = [];
  for (const source of DOC_SOURCES) {
    console.log(`📄 Fetching: ${source.title}`);
    const doc = await fetchDoc(source);
    if (doc) {
      console.log(`  ✂️  ${doc.chunks.length} chunks`);
      prepared.push(doc);
    }
  }

  // Always include the curated fallback docs so coverage is guaranteed.
  for (const f of FALLBACK_DOCS) {
    prepared.push({ title: f.title, source: f.source, chunks: chunkText(f.content) });
  }

  let totalChunks = 0;
  const BATCH_SIZE = 20;

  for (const doc of prepared) {
    for (let i = 0; i < doc.chunks.length; i += BATCH_SIZE) {
      const batch = doc.chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await embedBatch(batch);

      const rows = batch.map((content, j) => ({
        title: `${doc.title} (chunk ${i + j + 1})`,
        content,
        source: doc.source,
        embedding: JSON.stringify(embeddings[j]),
      }));

      const { error } = await supabase.from('documents').insert(rows);
      if (error) throw new Error(`Insert failed: ${error.message}`);
      totalChunks += rows.length;
    }
    console.log(`  ✅ ${doc.title}: embedded`);
  }

  console.log(`\n🎉 Embedded ${totalChunks} total chunks into documents table`);
}

main().catch((err) => {
  console.error('❌ embed-docs failed:', err);
  process.exit(1);
});
