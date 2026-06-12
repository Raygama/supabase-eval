import OpenAI from 'openai';
import 'dotenv/config';

/**
 * Embeddings client singleton.
 *
 * We prefer OpenRouter (a funded, OpenAI-compatible gateway) when
 * `OPENROUTER_KEY` is set, and fall back to a direct OpenAI key otherwise.
 * Both speak the same Embeddings API, so only the base URL, key, and the model
 * slug prefix differ. OpenRouter proxies `openai/text-embedding-3-small`, which
 * returns the same 1536-dim vectors the `documents.embedding` column expects.
 */

const useOpenRouter = !!process.env.OPENROUTER_KEY;

if (!useOpenRouter && !process.env.OPENAI_API_KEY) {
  throw new Error('Set OPENROUTER_KEY (preferred) or OPENAI_API_KEY for embeddings');
}

export const openai = useOpenRouter
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** The embedding model. 1536 dims matches the `documents.embedding` column. */
export const EMBEDDING_MODEL = useOpenRouter
  ? 'openai/text-embedding-3-small'
  : 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/** Embed a single string into a 1536-dim vector. */
export async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return res.data[0].embedding;
}

/** Embed many strings in one request. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}
