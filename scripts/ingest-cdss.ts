import fs from "fs";
import path from 'path';
import {PDFParse} from 'pdf-parse';
import { prisma } from "../src/config/database";

export const ROOT = path.resolve(process.cwd(), '../cdss');

export const listAllPdfs=async(dirPath:string):Promise<string[]>=>{
  const files=await fs.promises.readdir(dirPath);
  const pdfFiles:string[]=[];
    for(const file of files){
        const filePath=path.join(dirPath,file);
        const stat=await fs.promises.stat(filePath);
        if(stat.isDirectory()){
            const nestedPdfs=await listAllPdfs(filePath);
            pdfFiles.push(...nestedPdfs);
        }else if(path.extname(file).toLowerCase()===".pdf"){
            pdfFiles.push(filePath);
        }
    }
    return pdfFiles;
};


export const getLabels=(fullPath:string)=>{
    const relative= path.relative(ROOT,fullPath);
    const parts=relative.split(path.sep);

    const fileName=parts[parts.length-1];
    const collection=parts[0];
    const category  = parts.length >= 3 ? parts[1] : null;                 
    const specialty = parts.length >= 4 ? parts[parts.length - 2] : null;
    const sourceId = relative.replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    return {fileName, collection, category, specialty, sourceId};
}

async function main() {
    const pdfFiles=await listAllPdfs(ROOT);
    console.log(`Found ${pdfFiles.length} PDF files in ${ROOT}`);

    let needOcr=0;

    for (const [i,pdfFile] of pdfFiles.entries()) {
        const labels=getLabels(pdfFile);
        try {
            const buffer=await fs.promises.readFile(pdfFile);
            const {pages}=await new PDFParse({data:buffer}).getText();
            const rows = pages
                .map((p: any) => ({
                sourceId:   labels.sourceId,
                collection: labels.collection,
                category:   labels.category,
                specialty:  labels.specialty,
                fileName:   labels.fileName,
                page:       p.num,
                text:       (p.text || '').trim(),
                }))
                .filter((r:any) => r.text.length > 0);
            
                if(rows.length==0){
                    needOcr++;
                    console.warn(`  ⚠ no text (scanned?): ${labels.fileName}`);
                }

                await prisma.cdssPage.deleteMany({ where: { sourceId: labels.sourceId } });
                if (rows.length) await prisma.cdssPage.createMany({ data: rows });
                console.log(`[${i + 1}/${pdfFiles.length}] ${labels.fileName} → ${rows.length} pages`);

        } catch (error) {
            console.error(`  ✖ failed: ${pdfFile}`, (error as Error).message);
        }
    } 
    console.log(`Done. PDFs needing OCR: ${needOcr}`);
    await prisma.$disconnect();
}

// Only run ingestion when this file is executed directly, NOT when its
// helpers (listAllPdfs/getLabels/ROOT) are imported by another script.
if (require.main === module) {
    main();
}




















































































































































































































































































































