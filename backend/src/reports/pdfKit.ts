// Shared PDF design toolkit (pdf-lib) for the Interview Assist documents.
//
// Visual identity — "assessment dossier": an indigo brand band, a filled score
// card, semantic chips (emerald = strong/easy, amber = medium/concern,
// rose = weak/hard), thin hairline rules, and a quiet footer with page numbers.
// Used by the scoring report and the question-bank PDF so both feel like one set.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

export const C = {
  ink: rgb(0.08, 0.094, 0.122),       // #14181F
  muted: rgb(0.357, 0.408, 0.471),    // #5B6878
  faint: rgb(0.62, 0.66, 0.71),
  brand: rgb(0.357, 0.239, 0.961),    // #5B3DF5
  brandDeep: rgb(0.27, 0.16, 0.78),
  brandSoft: rgb(0.925, 0.914, 0.996),// #ECE9FE
  emerald: rgb(0.082, 0.569, 0.239),
  emeraldSoft: rgb(0.88, 0.96, 0.91),
  amber: rgb(0.706, 0.325, 0.035),
  amberSoft: rgb(0.99, 0.93, 0.83),
  rose: rgb(0.745, 0.071, 0.235),
  roseSoft: rgb(0.99, 0.89, 0.92),
  hairline: rgb(0.894, 0.906, 0.925), // #E4E7EC
  panel: rgb(0.973, 0.976, 0.984),
  white: rgb(1, 1, 1),
};

export const PAGE = { w: 595.28, h: 841.89 }; // A4 portrait
export const M = 48;
export const CONTENT_W = PAGE.w - M * 2;

export type Tone = "brand" | "emerald" | "amber" | "rose" | "neutral";
const TONE: Record<Tone, { fg: RGB; bg: RGB }> = {
  brand: { fg: C.brand, bg: C.brandSoft },
  emerald: { fg: C.emerald, bg: C.emeraldSoft },
  amber: { fg: C.amber, bg: C.amberSoft },
  rose: { fg: C.rose, bg: C.roseSoft },
  neutral: { fg: C.muted, bg: C.panel },
};

export function toneFor(label: string | undefined): Tone {
  const s = (label ?? "").toLowerCase();
  // Overall-verdict labels (Good/Above Average/Average/Below Average/Poor) — checked
  // first since "average" is a substring of "below average" / "above average".
  if (/below average|\bpoor\b/.test(s)) return "rose";
  if (/above average|\bgood\b/.test(s)) return "emerald";
  if (/\baverage\b/.test(s)) return "amber";
  if (/easy|strong|adequate|manual|pass|yes/.test(s)) return "emerald";
  if (/medium|weak|borderline|concern/.test(s)) return "amber";
  if (/hard|bad|vague|off|no|skip/.test(s)) return "rose";
  return "neutral";
}

export class Pdf {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page!: PDFPage;
  y = 0;
  ownPages = 0; // pages this toolkit drew (footers only go on these)

  private constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
  }
  static async create(): Promise<Pdf> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const p = new Pdf(doc, font, bold);
    p.addPage();
    return p;
  }

  addPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.ownPages++;
    this.y = PAGE.h - M;
  }
  ensure(space: number) {
    if (this.y - space < M + 28) this.addPage();
  }

  private lines(text: string, size: number, font: PDFFont, maxW: number): string[] {
    const out: string[] = [];
    for (const raw of String(text ?? "").split(/\r?\n/)) {
      let line = "";
      for (const word of raw.split(/\s+/)) {
        const trial = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(trial, size) > maxW && line) { out.push(line); line = word; }
        else line = trial;
      }
      out.push(line);
    }
    return out;
  }

  // The page-1 brand band with a title + meta line. Leaves the cursor below it.
  band(title: string, meta?: string) {
    const h = 92;
    this.page.drawRectangle({ x: 0, y: PAGE.h - h, width: PAGE.w, height: h, color: C.brand });
    this.page.drawRectangle({ x: 0, y: PAGE.h - h, width: PAGE.w, height: 4, color: C.brandDeep });
    this.page.drawText("INTERVIEW ASSIST", { x: M, y: PAGE.h - 30, size: 8.5, font: this.bold, color: rgb(0.84, 0.82, 1) });
    this.page.drawText(title, { x: M, y: PAGE.h - 58, size: 23, font: this.bold, color: C.white });
    if (meta) this.page.drawText(meta, { x: M, y: PAGE.h - 78, size: 10, font: this.font, color: rgb(0.88, 0.86, 1) });
    this.y = PAGE.h - h - 26;
  }

  eyebrow(label: string) {
    this.ensure(22);
    this.page.drawText(label.toUpperCase(), { x: M, y: this.y - 9, size: 8.5, font: this.bold, color: C.brand });
    this.y -= 14;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: PAGE.w - M, y: this.y }, thickness: 0.75, color: C.hairline });
    this.y -= 12;
  }

  text(text: string, opts: { size?: number; bold?: boolean; color?: RGB; gap?: number; indent?: number; lineGap?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    const x = M + (opts.indent ?? 0);
    const lh = size * (opts.lineGap ?? 1.4);
    for (const line of this.lines(text, size, font, CONTENT_W - (opts.indent ?? 0))) {
      this.ensure(lh);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? C.ink });
      this.y -= lh;
    }
    this.y -= opts.gap ?? 0;
  }

  bullet(text: string, color: RGB = C.ink) {
    const size = 10.5, lh = size * 1.4;
    this.ensure(lh);
    this.page.drawCircle({ x: M + 3, y: this.y - size + 3, size: 1.6, color });
    for (const [i, line] of this.lines(text, size, this.font, CONTENT_W - 14).entries()) {
      if (i > 0) this.ensure(lh);
      this.page.drawText(line, { x: M + 14, y: this.y - size, size, font: this.font, color: C.ink });
      this.y -= lh;
    }
  }

  // A small filled tag. Returns its width so callers can place text after it.
  chip(x: number, yTop: number, label: string, tone: Tone): number {
    const size = 8;
    const padX = 6, h = 14;
    const w = this.bold.widthOfTextAtSize(label.toUpperCase(), size) + padX * 2;
    const t = TONE[tone];
    this.page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: t.bg });
    this.page.drawText(label.toUpperCase(), { x: x + padX, y: yTop - h + 4, size, font: this.bold, color: t.fg });
    return w;
  }

  rule(gap = 12) {
    this.ensure(gap + 2);
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: PAGE.w - M, y: this.y }, thickness: 0.75, color: C.hairline });
    this.y -= gap;
  }

  gap(n: number) { this.y -= n; }

  // Footer (page numbers) on every page this toolkit drew. Call before save.
  private footers() {
    const pages = this.doc.getPages();
    for (let i = 0; i < this.ownPages && i < pages.length; i++) {
      const p = pages[i];
      p.drawLine({ start: { x: M, y: 38 }, end: { x: PAGE.w - M, y: 38 }, thickness: 0.5, color: C.hairline });
      p.drawText("Interview Assist · JoulesToWatts", { x: M, y: 26, size: 7.5, font: this.font, color: C.faint });
      const label = `Page ${i + 1} of ${this.ownPages}`;
      const w = this.font.widthOfTextAtSize(label, 7.5);
      p.drawText(label, { x: PAGE.w - M - w, y: 26, size: 7.5, font: this.font, color: C.faint });
    }
  }

  async save(): Promise<Uint8Array> {
    this.footers();
    return this.doc.save();
  }
}
