import { prisma } from "../src/config/database";

const MAX_CHUNK = 1500;  
const OVERLAP   = 200; 

const chunkText = (text: string, maxChunk: number, overlap: number) => {
    const chunks: string[] = [];
    let start = 0;

    const newText = text.replace(/\s+/g, ' ').trim();
    while (start < newText.length) {                    
        const end = start + maxChunk;
        const chunk = newText.slice(start, end).trim();
        if (chunk) chunks.push(chunk);
        start += (maxChunk - overlap);
    }
    return chunks;
};

async function main(){
    const pages=await prisma.cdssPage.findMany({select:{id:true,text:true}});

    let totalChunk=0;

    for(const page of pages){
        const chunk=chunkText(page.text,MAX_CHUNK,OVERLAP);

        const rows=chunk.map((a:any,index:number)=>({
            pageId:page.id,
            chunkIndex:index,
            chunkText:a,
        }))
        await prisma.cdssChunk.deleteMany({where:{pageId:page.id}});
        if(rows.length)await prisma.cdssChunk.createMany({data:rows});

        totalChunk+=rows.length;
    }
    console.log(`Done. ${totalChunk} chunks created from ${pages.length} pages.`);
    await prisma.$disconnect();
}



main();