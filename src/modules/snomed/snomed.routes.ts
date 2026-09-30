import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { searchSnomed, snomedSelect } from './snomed.controller';
import { mapSnomedSchema, searchSnomedSchema } from './snomed.validation';

export const snomedRoutes = Router();

snomedRoutes.get('/search', validate(searchSnomedSchema), searchSnomed);
snomedRoutes.get('/:conceptId/map', validate(mapSnomedSchema), snomedSelect);
