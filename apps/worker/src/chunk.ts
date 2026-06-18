import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// Tuning (from the plan): 800 tokens, 120 overlap. LangChain sizes in
// characters by default — approximate 1 token ≈ 4 chars for English so
// 800 tokens ≈ 3200 chars. Good enough for retrieval quality; we index
// actual token counts for cost accounting.

export interface Chunk {
  ord: number;
  text: string;
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 3200,
  chunkOverlap: 480,
  separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " "],
});

export async function chunkText(text: string): Promise<Chunk[]> {
  const parts = await splitter.splitText(text);
  return parts
    .map((t) => t.trim())
    .filter((t) => t.length >= 40) // drop tiny fragments that aren't retrievable
    .map((text, ord) => ({ ord, text }));
}

// Rough token estimate — used for cost tracking, not trimming.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
