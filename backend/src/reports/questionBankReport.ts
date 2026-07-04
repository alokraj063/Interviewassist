// JD Question Bank (PDF): skill-wise, with difficulty chips. Shares the
// "assessment dossier" identity with the scoring report.
// Used by GET /api/demands/:id/question-bank/download.
import { Pdf, C, M, PAGE, toneFor } from "./pdfKit.js";

export interface QuestionBank {
  skills?: Array<{ skill?: string; questions?: Array<{ difficulty?: string; question?: string }> }>;
  total?: number;
}

export async function buildQuestionBankReport(
  bank: QuestionBank,
  meta: { title?: string | null; client?: string | null; version?: number; addedJd?: string },
): Promise<Uint8Array> {
  const pdf = await Pdf.create();
  const skills = (bank.skills ?? []).filter((s) => (s.questions ?? []).length > 0);
  const total = bank.total ?? skills.reduce((n, s) => n + (s.questions?.length ?? 0), 0);

  const metaBits = [meta.title, meta.client].filter(Boolean);
  pdf.band("Question Bank", metaBits.join("   ·   ") || undefined);

  // Summary line: counts + version.
  pdf.text(
    `${total} questions  ·  ${skills.length} skill${skills.length === 1 ? "" : "s"}${meta.version ? `  ·  Version ${meta.version}` : ""}`,
    { size: 10, color: C.muted, gap: meta.addedJd ? 4 : 14 },
  );
  if (meta.addedJd) {
    pdf.text(`Added to JD: ${meta.addedJd}`, { size: 9.5, color: C.amber, gap: 14 });
  }

  let n = 0;
  for (const group of skills) {
    skillHeader(pdf, group.skill ?? "General", group.questions?.length ?? 0);
    for (const q of group.questions ?? []) {
      n++;
      pdf.ensure(34);
      const cw = pdf.chip(M, pdf.y, q.difficulty ?? "Medium", toneFor(q.difficulty));
      pdf.text(`${n}.  ${q.question ?? ""}`, { indent: cw + 10, size: 10.5, gap: 9 });
    }
    pdf.gap(6);
  }

  return pdf.save();
}

function skillHeader(pdf: Pdf, skill: string, count: number) {
  pdf.ensure(28);
  pdf.page.drawText(skill, { x: M, y: pdf.y - 12, size: 12.5, font: pdf.bold, color: C.brandDeep });
  const label = `${count} q`;
  const w = pdf.font.widthOfTextAtSize(label, 9);
  pdf.page.drawText(label, { x: PAGE.w - M - w, y: pdf.y - 11, size: 9, font: pdf.font, color: C.muted });
  pdf.y -= 17;
  pdf.page.drawLine({ start: { x: M, y: pdf.y }, end: { x: PAGE.w - M, y: pdf.y }, thickness: 0.75, color: C.hairline });
  pdf.y -= 12;
}
