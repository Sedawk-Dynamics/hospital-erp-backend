import fs from 'fs';
import path from 'path';
import type { PdfFontFamily } from './pdf-template';
import { logger } from '../config/logger';

// ---------------------------------------------------------------------------
// Embedded document fonts.
//
// PDFKit's built-in Helvetica / Times / Courier are WinAnsi-encoded and have NO
// glyph for the Indian rupee sign — `widthOfString('₹')` is 0, so the symbol
// silently prints as nothing. Every amount on a bill or receipt came out as
// " 1,234.00" with a hole where the currency should be, and the IP bill had
// dropped the symbol from its formatter entirely to hide it.
//
// So the three families are backed by DejaVu, which covers the rupee sign along
// with the bullet, true minus, middle dot and em dash these documents use.
// DejaVu is chosen because its licence permits redistribution and it ships
// matching sans / serif / mono faces, so the template's font choice still means
// something.
//
// If the files are missing — a build that did not copy `assets/` — this falls
// back to the built-ins rather than failing to produce a document at all. A bill
// without a rupee sign beats no bill.
// ---------------------------------------------------------------------------

/**
 * `assets/` sits next to `dist/` in the image and next to `src/` in dev, and
 * this file resolves to `<root>/dist/services` or `<root>/src/services` in the
 * two cases — so the same relative hop finds it either way. `process.cwd()` is
 * tried first for the case where the server is started from elsewhere.
 */
function resolveFontDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(__dirname, '../../assets/fonts'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'DejaVuSans.ttf'))) return dir;
    } catch {
      // unreadable path — try the next candidate
    }
  }
  return null;
}

const FILES: Record<PdfFontFamily, { regular: string; bold: string; italic: string }> = {
  Helvetica: {
    regular: 'DejaVuSans.ttf',
    bold: 'DejaVuSans-Bold.ttf',
    italic: 'DejaVuSans-Oblique.ttf',
  },
  Times: {
    regular: 'DejaVuSerif.ttf',
    bold: 'DejaVuSerif-Bold.ttf',
    italic: 'DejaVuSerif-Italic.ttf',
  },
  Courier: {
    regular: 'DejaVuSansMono.ttf',
    bold: 'DejaVuSansMono-Bold.ttf',
    italic: 'DejaVuSansMono-Oblique.ttf',
  },
};

/** Resolved once — the directory does not move while the process is running. */
let fontDir: string | null | undefined;

function dir(): string | null {
  if (fontDir === undefined) {
    fontDir = resolveFontDir();
    if (!fontDir) {
      logger.warn(
        'PDF fonts not found (assets/fonts) — documents will fall back to the built-in ' +
          'Helvetica/Times/Courier, which cannot render the rupee sign.',
      );
    }
  }
  return fontDir;
}

export interface FontSet {
  regular: string;
  bold: string;
  italic: string;
}

/** Whether the embedded faces are available to this process. */
export function embeddedFontsAvailable(): boolean {
  return dir() !== null;
}

/**
 * Register the family's three faces on this document and return the names to
 * draw with. Returns null when the files are unavailable, in which case the
 * caller keeps PDFKit's built-in names.
 *
 * The aliases are per-document, so the fixed names are safe.
 */
export function registerEmbeddedFonts(
  pdf: PDFKit.PDFDocument,
  family: PdfFontFamily,
): FontSet | null {
  const base = dir();
  if (!base) return null;
  const files = FILES[family] ?? FILES.Helvetica;
  const names: FontSet = { regular: 'doc-regular', bold: 'doc-bold', italic: 'doc-italic' };
  try {
    pdf.registerFont(names.regular, path.join(base, files.regular));
    pdf.registerFont(names.bold, path.join(base, files.bold));
    pdf.registerFont(names.italic, path.join(base, files.italic));
    return names;
  } catch (err) {
    // A corrupt or truncated file must not take the whole document down.
    logger.warn({ err, family }, 'Could not embed PDF fonts — falling back to the built-ins');
    return null;
  }
}
