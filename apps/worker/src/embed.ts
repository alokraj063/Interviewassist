import OpenAI from "openai";
import { env } from "./env.js";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

export const EMBEDDING_DIMS = 1536;

// Batch-embed. OpenAI accepts up to 2048 inputs per request but throughput is
// best around 100 — stay conservative to keep individual requests fast.
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const BATCH = 100;
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await client().embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: slice,
    });
    for (let j = 0; j < res.data.length; j++) {
      out[i + j] = res.data[j].embedding;
    }
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v;
}
