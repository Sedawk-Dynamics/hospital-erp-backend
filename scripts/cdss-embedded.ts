import { prisma } from "../src/config/database";
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();


export const embedText=async(text: string): Promise<number[]>=> {
  const res = await axios.post('http://localhost:11434/api/embeddings', {
    model: 'nomic-embed-text',
    prompt: text,
  });
  const vector = res.data.embedding as number[];   // 768 numbers
  if (vector.length !== 768) {
    throw new Error(`Expected 768 dims, got ${vector.length}`);
  }
  return vector;
}

async function main(){
    const chunks=await prisma.cdssChunk.findMany({select:{id:true,chunkText:true}});

    for(const chunk of chunks){
        const vector=await embedText(chunk.chunkText);
        const vectorStr=`[${vector.join(',')}]`
        await prisma.$executeRaw`
        UPDATE cdss_chunks SET embedding = ${vectorStr}::vector WHERE id = ${chunk.id}`;
    }
    await prisma.$disconnect();
}

main()





































