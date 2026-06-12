import OpenAI from 'openai';
import 'dotenv/config';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

/** OpenAI client singleton — used for document + query embeddings. */
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** The embedding model. 1536 dims matches the `documents.embedding` column. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
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
