// Parse uploaded documents into plain text. Returns a canonicalized string
// that the chunker can split without needing to know the source format.
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export interface ParsedDocument {
  text: string;
  meta: {
    pages?: number;
    paragraphs?: number;
    warnings?: string[];
  };
}

export async function parseDocument(content: Buffer, mime: string, filename?: string): Promise<ParsedDocument> {
  const m = (mime || guessMime(filename ?? "")).toLowerCase();

  if (m === "application/pdf" || m.includes("pdf")) {
    const res = await pdfParse(content);
    return { text: cleanText(res.text), meta: { pages: res.numpages } };
  }

  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    m.includes("docx") ||
    m.includes("msword")
  ) {
    const res = await mammoth.extractRawText({ buffer: content });
    return {
      text: cleanText(res.value),
      meta: { warnings: res.messages?.map((msg) => msg.message) },
    };
  }

  if (m === "text/markdown" || m === "text/plain" || m.startsWith("text/")) {
    return { text: cleanText(content.toString("utf8")), meta: {} };
  }

  // Fallback — assume utf8 text. The chunker will tolerate noise.
  return { text: cleanText(content.toString("utf8")), meta: {} };
}

function cleanText(t: string): string {
  return t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "doc":
      return "application/msword";
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}
