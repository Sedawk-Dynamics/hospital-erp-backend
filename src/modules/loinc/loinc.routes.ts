import { Router } from 'express';
import { searchLoinc } from './loinc.controller';

export const loincRoutes = Router();

loincRoutes.get('/search', searchLoinc);