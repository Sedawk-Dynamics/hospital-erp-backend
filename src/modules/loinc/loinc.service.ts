import { prisma } from "../../config/database";   // ✅


export const loincSearch=async(query:string)=>{
    const labName=query.trim().toLocaleLowerCase();
    if (!labName) return [];

    const rows=await prisma.loincCatalog.findMany({
        where:{
            OR:[
            {loincCode:{contains:labName,mode:"insensitive"}},
            {displayName:{contains:labName,mode:"insensitive"}},
            {component:{contains:labName,mode:"insensitive"}},
            {system:{contains:labName,mode:"insensitive"}},
            {scaleType:{contains:labName,mode:"insensitive"}},
            ]
        },
        take:20,
        select: {id:true, loincCode: true, displayName: true,component:true,system:true,scaleType:true }
    })
    return rows;
}

