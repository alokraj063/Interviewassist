// Candidate interview REPORT (PDF): a polished evaluation — verdict, overall +
// dimension scores, summary, strengths, concerns, per-question Q&A — followed by
// the candidate's résumé (original PDF pages merged in, or text rendered).
// Used by GET /api/calls/:id/report.
import { PDFDocument, rgb } from "pdf-lib";
import { parseDocument } from "@j2w/ingest-shared";
import { Pdf, C, M, PAGE, CONTENT_W, toneFor } from "./pdfKit.js";

export interface InterviewEval {
  verdict?: string;
  score?: Record<string, number>;
  summary?: string;
  strengths?: string[];
  concerns?: string[];
  candidateName?: string;
  generatedAt?: string;
  questionCount?: number;
  answeredCount?: number;
  questions?: Array<{ category?: string; question?: string; answer?: string; verdict?: string; feedback?: string }>;
}

const scoreColor = (v: number) => (v >= 70 ? C.emerald : v >= 45 ? C.amber : C.rose);
const DIMS: Array<[string, string]> = [
  ["communication", "Communication"],
  ["relevance", "Relevance"],
  ["depth", "Depth"],
  ["skills_match", "Skills match"],
];

export async function buildInterviewReport(
  ev: InterviewEval,
  resume: { buf: Buffer; mime?: string | null; filename?: string | null } | null,
): Promise<Uint8Array> {
  const pdf = await Pdf.create();
  const metaBits = [ev.candidateName, ev.generatedAt ? new Date(ev.generatedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null].filter(Boolean);
  pdf.band("Interview Evaluation", metaBits.join("   ·   ") || undefined);

  // ---- Score hero: overall card + verdict + dimension bars ----
  const cardW = 150, cardH = 110;
  pdf.ensure(cardH + 16);
  const top = pdf.y;
  pdf.page.drawRectangle({ x: M, y: top - cardH, width: cardW, height: cardH, color: C.brand });
  pdf.page.drawText("OVERALL", { x: M + 18, y: top - 26, size: 9, font: pdf.bold, color: rgb(0.84, 0.82, 1) });
  const overall = ev.score?.overall;
  pdf.page.drawText(overall != null ? String(overall) : "—", { x: M + 16, y: top - 78, size: 48, font: pdf.bold, color: C.white });
  pdf.page.drawText("out of 100", { x: M + 18, y: top - 96, size: 9.5, font: pdf.font, color: rgb(0.86, 0.84, 1) });

  // Right column: verdict + bars
  const rx = M + cardW + 22;
  const rw = CONTENT_W - cardW - 22;
  pdf.page.drawText("VERDICT", { x: rx, y: top - 12, size: 8.5, font: pdf.bold, color: C.muted });
  const vTone = toneFor(ev.verdict);
  const vColor = vTone === "emerald" ? C.emerald : vTone === "amber" ? C.amber : vTone === "rose" ? C.rose : C.ink;
  pdf.page.drawText(ev.verdict ?? "—", { x: rx, y: top - 32, size: 17, font: pdf.bold, color: vColor });

  let by = top - 52;
  for (const [key, label] of DIMS) {
    const v = ev.score?.[key];
    pdf.page.drawText(label, { x: rx, y: by - 8, size: 8.5, font: pdf.font, color: C.muted });
    pdf.page.drawText(v != null ? String(v) : "—", { x: rx + rw - 18, y: by - 8, size: 9, font: pdf.bold, color: C.ink });
    const trackY = by - 13, trackW = rw;
    pdf.page.drawRectangle({ x: rx, y: trackY, width: trackW, height: 4, color: C.hairline });
    if (v != null) pdf.page.drawRectangle({ x: rx, y: trackY, width: Math.max(2, (Math.min(100, v) / 100) * trackW), height: 4, color: scoreColor(v) });
    by -= 21;
  }
  pdf.y = top - cardH - 20;

  // ---- Summary ----
  if (ev.summary) {
    pdf.eyebrow("Summary");
    pdf.text(ev.summary, { size: 10.5, gap: 12 });
  }

  // ---- Strengths / Concerns ----
  if (ev.strengths?.length) {
    pdf.eyebrow("Strengths");
    ev.strengths.forEach((s) => pdf.bullet(s, C.emerald));
    pdf.gap(10);
  }
  if (ev.concerns?.length) {
    pdf.eyebrow("Concerns");
    ev.concerns.forEach((s) => pdf.bullet(s, C.rose));
    pdf.gap(10);
  }

  // ---- Q&A ----
  if (ev.questions?.length) {
    const total = ev.questionCount ?? ev.questions.length;
    const answered = ev.answeredCount ?? ev.questions.filter((q) => (q.answer ?? "").trim() && q.verdict !== "Off-topic").length;
    pdf.eyebrow(`Questions & Answers  —  answered ${answered} of ${total}`);
    ev.questions.forEach((q, i) => {
      pdf.ensure(64);
      const startPage = pdf.page;
      const startY = pdf.y;
      let cx = M + 12;
      const tone = toneFor(q.verdict);
      if (q.verdict) cx += pdf.chip(cx, pdf.y, q.verdict, tone) + 6;
      if (q.category) pdf.page.drawText(q.category, { x: cx, y: pdf.y - 11, size: 8.5, font: pdf.bold, color: C.faint });
      pdf.y -= 20;
      pdf.text(`Q${i + 1}.  ${q.question ?? ""}`, { bold: true, size: 10.5, indent: 12, gap: 3 });
      if (q.answer) pdf.text(q.answer, { size: 10, color: C.muted, indent: 12, gap: 2 });
      if (q.feedback) pdf.text(q.feedback, { size: 9.5, color: C.faint, indent: 12, gap: 2 });
      // Left accent border (only if the item didn't cross a page).
      if (pdf.page === startPage) {
        const t = tone === "emerald" ? C.emerald : tone === "amber" ? C.amber : tone === "rose" ? C.rose : C.brand;
        pdf.page.drawRectangle({ x: M, y: pdf.y + 2, width: 2.5, height: startY - pdf.y - 2, color: t });
      }
      pdf.gap(12);
    });
  }

  // ---- Résumé ----
  if (resume) {
    const isPdf = (resume.mime ?? "").includes("pdf") || (resume.filename ?? "").toLowerCase().endsWith(".pdf");
    if (isPdf) {
      try {
        const src = await PDFDocument.load(resume.buf, { ignoreEncryption: true });
        const pages = await pdf.doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => pdf.doc.addPage(p)); // appended after eval pages; no footer
      } catch {
        await renderResumeText(pdf, resume);
      }
    } else {
      await renderResumeText(pdf, resume);
    }
  }

  return pdf.save();
}

async function renderResumeText(pdf: Pdf, resume: { buf: Buffer; mime?: string | null; filename?: string | null }) {
  pdf.addPage();
  pdf.band("Résumé", resume.filename ?? undefined);
  try {
    const { text } = await parseDocument(resume.buf, resume.mime ?? "application/octet-stream", resume.filename ?? "resume");
    pdf.text(text || "(résumé text could not be extracted)", { size: 10, color: C.ink, lineGap: 1.45 });
  } catch {
    pdf.text("(résumé could not be rendered)", { size: 10, color: C.muted });
  }
  void PAGE;
}
