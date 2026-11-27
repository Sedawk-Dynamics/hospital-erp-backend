import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { prisma } from '../../config/database';
import { callGeminiVisionImages } from '../../services/gemini-vision';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? '';
const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const VOYAGE_MODEL = 'voyage-multimodal-3.5';

export const CDSS_ROOT = process.env.CDSS_ROOT ?? path.resolve(process.cwd(), '../cdss');

export async function embedQuery(text: string): Promise<number[]> {
  const res = await axios.post(
    VOYAGE_URL,
    {
      model: VOYAGE_MODEL,
      input_type: 'query',
      inputs: [{ content: [{ type: 'text', text }] }],
    },
    { headers: { Authorization: `Bearer ${VOYAGE_API_KEY}` } },
  );
  return res.data.data[0].embedding as number[];
}

export interface PageMatch {
  sourceId: string;
  fileName: string;
  collection: string;
  category: string | null;
  specialty: string | null;
  page: number;
  sourcePath: string | null;
}

export async function retrievePages(queryVec: number[], k = 3): Promise<PageMatch[]> {
  return prisma.$queryRaw<PageMatch[]>`
    SELECT source_id   AS "sourceId",
           file_name   AS "fileName",
           collection,
           category,
           specialty,
           page,
           source_path AS "sourcePath"
    FROM cdss_page_images
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${`[${queryVec.join(',')}]`}::vector
    LIMIT ${k}`;
}

let mupdfMod: any = null;
async function getMupdf(): Promise<any> {

  if (!mupdfMod) mupdfMod = await (new Function('return import("mupdf")')());
  return mupdfMod;
}


export async function renderPage(sourcePath: string, page: number): Promise<Buffer> {
  const mupdf = await getMupdf();
  const fullPath = path.join(CDSS_ROOT, sourcePath);
  const data = await fs.promises.readFile(fullPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    const pg = doc.loadPage(page - 1); // stored page is 1-based; loadPage is 0-based
    const pix = pg.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
    const png = Buffer.from(pix.asPNG());
    pix.destroy();
    pg.destroy();
    return png;
  } finally {
    doc.destroy();
  }
}

export interface GuidelineSource {
  n: number;
  label: string;
  url: string;
}

const cleanName = (s?: string | null) =>
  (s ?? '').replace(/^\d+\.\s*/, '').replace(/\.pdf$/i, '').trim();

const labelFor = (p: PageMatch) => {
  const programme = cleanName(p.specialty) || cleanName(p.category) || p.collection;
  return `${programme} — ${cleanName(p.fileName)}, p.${p.page}`;
};


export async function buildGuidelineContext(
  contextText: string,
  k = 3,
): Promise<{ guidelines: string; sources: GuidelineSource[] } | null> {
  const queryVec = await embedQuery(contextText);
  const matches = (await retrievePages(queryVec, k)).filter((p) => p.sourcePath);
  if (!matches.length) return null;

  const images: { data: Buffer; mimetype: string }[] = [];
  const sources: GuidelineSource[] = [];
  const labelLines: string[] = [];

  for (let i = 0; i < matches.length; i++) {
    const p = matches[i];
    try {
      const png = await renderPage(p.sourcePath!, p.page);
      images.push({ data: png, mimetype: 'image/png' });
      const label = labelFor(p);
      sources.push({ n: images.length, label, url: `/api/v1/ai/cdss/source/${p.sourceId}#page=${p.page}` });
      labelLines.push(`[[${images.length}]] = ${label}`);
    } catch {
    }
  }
  if (!images.length) return null;

  const prompt = [
    'You are reading clinical guideline PAGES provided as images. Each image is numbered:',
    ...labelLines,
    '',
    'From these pages ONLY, extract the guidance relevant to the patient summary below.',
    'Write concise, clinically useful points. Cite each point with its image number in',
    'double brackets, e.g. [[1]]. Do not use any knowledge outside these pages. If the',
    'pages are not relevant to the patient, reply exactly: NONE',
    '',
    '=== PATIENT SUMMARY ===',
    contextText.slice(0, 4000),
  ].join('\n');

  const { text } = await callGeminiVisionImages({
    prompt,
    images,
    feature: 'Guideline retrieval',
    fallbackHint: 'Proceeding without guideline context.',
  });

  const guidelines = text.trim();
  if (!guidelines || guidelines.toUpperCase() === 'NONE') return null;

  return { guidelines, sources };
}
