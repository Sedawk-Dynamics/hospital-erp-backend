import path from "path";
import { prisma } from "../src/config/database";
import { listAllPdfs, ROOT, getLabels } from "./ingest-cdss";

async function main() {
    const pdfFiles = await listAllPdfs(ROOT);
    console.log(`Found ${pdfFiles.length} PDFs. Backfilling source_path...`);

    let updated = 0;
    for (const pdf of pdfFiles) {
        const { sourceId } = getLabels(pdf);
        const relativePath = path.relative(ROOT, pdf);
        const res = await prisma.cdssPage.updateMany({
            where: { sourceId },
            data: { sourcePath: relativePath },
        });
        updated += res.count;
    }

    console.log(`Done. Updated ${updated} page rows.`);
    await prisma.$disconnect();
}

main();
