import { Request, Response, NextFunction } from 'express';
import { loincSearch } from './loinc.service';

export const searchLoinc=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const results = await loincSearch(q);
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}