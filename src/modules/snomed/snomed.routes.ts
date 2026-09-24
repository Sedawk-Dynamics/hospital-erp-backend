import { Router } from 'express';
import { searchSnomed,snomedSelect } from './snomed.controller';

export const snomedRoutes = Router();

snomedRoutes.get('/search', searchSnomed);
snomedRoutes.get("/:conceptId/map",snomedSelect);

