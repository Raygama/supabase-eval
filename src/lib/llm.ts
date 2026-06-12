import OpenAI from 'openai';
import 'dotenv/config';

/**
 * Chat-completions client singleton for the agent and the LLM judge.
 *
 * We route through OpenRouter (OpenAI-compatible) so a single funded key backs
 * both Claude-quality reasoning and embeddings. OpenRouter exposes Anthropic
 * models under slugs like `anthropic/claude-haiku-4.5` over the standard
 * `/chat/completions` endpoint, so we use the OpenAI SDK as the transport
 * rather than the Anthropic SDK (OpenRouter does not serve `/v1/messages`).
 *
 * If only a raw OpenAI key is present we fall back to it with a GPT model.
 */

const useOpenRouter = !!process.env.OPENROUTER_KEY;

export const llm = useOpenRouter
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Model used by both the agent and the judge. Cheap + capable for this workload. */
export const CHAT_MODEL = useOpenRouter ? 'anthropic/claude-sonnet-4.6' : 'gpt-4o-mini';

/** Throw early with a clear message if no chat-capable key is configured. */
export function assertChatConfigured(): void {
  if (!process.env.OPENROUTER_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENROUTER_KEY (preferred) or OPENAI_API_KEY to run the agent/judge');
  }
}
