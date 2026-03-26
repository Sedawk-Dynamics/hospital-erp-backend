import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './mrd.controller';

export const mrdRoutes = Router();

mrdRoutes.get(
  '/documents',
  authenticate,
  controller.getMrdDocuments,
);

mrdRoutes.post(
  '/documents',
  authenticate,
  controller.createMrdRequest,
);
