import { Request, Response, NextFunction } from 'express';
import { searchSnomedConcepts,selectedSnomed } from './snomed.service';

export async function searchSnomed(req: Request, res: Response, next: NextFunction) {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const results = await searchSnomedConcepts(q);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
}


export const snomedSelect=async(req:Request,res:Response,next:NextFunction)=>{
  try {
    const snomedCode=req.params.conceptId as string;
    const results = await selectedSnomed(snomedCode);
    res.json({ data: results });
  } catch (error) {
    next(error)
  }
}