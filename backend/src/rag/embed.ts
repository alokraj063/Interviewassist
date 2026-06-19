import OpenAI from "openai";
import { env } from "../env.js";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

export async function embedQuery(text: string): Promise<number[]> {
  const res = await client().embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: text,
  });
  return res.data[0].embedding;
}
