import fs from 'fs'
import path from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import type * as MupdfType from 'mupdf';
import { prisma } from '../src/config/database';
import { listAllPdfs, ROOT, getLabels } from './ingest-cdss';
import dotenv from 'dotenv';
dotenv.config();


const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY!;
const VOYAGE_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const MODEL = 'voyage-multimodal-3.5';


let mupdfMod: typeof MupdfType | null = null;
async function getMupdf(): Promise<typeof MupdfType> {
  if (!mupdfMod) mupdfMod = await import('mupdf');
  return mupdfMod;
}

async function renderPdfToPngs(pdfFile: string): Promise<{ pageNumber: number; content: Buffer }[]> {
  const mupdf = await getMupdf();
  const data = await fs.promises.readFile(pdfFile);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pages: { pageNumber: number; content: Buffer }[] = [];

  const count = doc.countPages();
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
    pages.push({ pageNumber: i + 1, content: Buffer.from(pix.asPNG()) });
    pix.destroy();
    page.destroy();
  }
  doc.destroy();
  return pages;
}


async function embedImage(png: Buffer, attempt = 1): Promise<number[]> {
  try {
    const res = await axios.post(
      VOYAGE_URL,
      {
        model: MODEL,
        input_type: 'document',
        inputs: [
          { content: [{ type: 'image_base64', image_base64: `data:image/png;base64,${png.toString('base64')}` }] },
        ],
      },
      { headers: { Authorization: `Bearer ${VOYAGE_API_KEY}` } },
    );
    return res.data.data[0].embedding as number[];
  } catch (err: any) {
    if (err?.response?.status === 429 && attempt <= 8) {
      return embedImage(png, attempt + 1);
    }
    throw err;
  }
}


async function main() {
  const pdfFiles = (await listAllPdfs(ROOT)).filter((f) =>
    path.relative(ROOT, f).toLowerCase().replace(/\\/g, '/')
      .includes('standard treatment workflows (stws)/stws volume iii/gastroenterology')
  );


  for (const [i, pdfFile] of pdfFiles.entries()) {
    const labels = getLabels(pdfFile);
    const sourcePath = path.relative(ROOT, pdfFile);
    try {
      console.log('→ rendering PDF to PNG...');
      const pages = await renderPdfToPngs(pdfFile);
      console.log(`→ rendered ${pages.length} pages. embedding + inserting (skipping done pages)...`);

      for (const pg of pages) {
        if (!pg.content) continue;

        const exists = await prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM cdss_page_images
        WHERE source_id = ${labels.sourceId} AND page = ${pg.pageNumber} LIMIT 1`;
        if (exists.length) { console.log(`  page ${pg.pageNumber}: skip (done)`); continue; }

        const vec = await embedImage(pg.content);
        console.log(`  page ${pg.pageNumber}: got ${vec.length}-dim vector`);


        await prisma.$executeRaw`
          INSERT INTO cdss_page_images
            (id, source_id, collection, category, specialty, file_name, source_path, page, embedding, created_at)
          VALUES
            (${randomUUID()}, ${labels.sourceId}, ${labels.collection}, ${labels.category},
             ${labels.specialty}, ${labels.fileName}, ${sourcePath}, ${pg.pageNumber},
             ${`[${vec.join(',')}]`}::vector, now())
        `;
      }
      console.log(`[${i + 1}/${pdfFiles.length}] ${labels.fileName} → ${pages.length} pages embedded`);
    } catch (err: any) {
      if (err?.response?.status === 429) {
        console.error('Rate/quota limit hit — stopping. Resume later.', err.response?.data);
        break;
      }
      console.error(`✖ failed: ${pdfFile}`);
      console.error('  message:', err.message);
      console.error('  voyage:', err.response?.data);
      console.error('  stack:', err.stack);
    }
  }
  await prisma.$disconnect();
}

main();