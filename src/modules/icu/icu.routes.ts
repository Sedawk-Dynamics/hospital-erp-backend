import { Router } from "express";
import { authenticate } from '../../middleware/authenticate';
import * as icuController from './icu.controller';
import { validate } from '../../middleware/validate';
import * as icuValidation from './icu.validations';

export const icuRoute=Router();

icuRoute.post('/admission/:admissionId/fluid-balance', authenticate, validate(icuValidation.fluidBalanceSchema), icuController.fluidBalance);
icuRoute.post('/admission/:admissionId/abg-vent',       authenticate, validate(icuValidation.abgVentSchema),       icuController.abgVent);
icuRoute.post('/admission/:admissionId/fast-hug',       authenticate, validate(icuValidation.fastHugSepsisSchema), icuController.fastHug);
icuRoute.post('/admission/:admissionId/invasive-line',  authenticate, validate(icuValidation.invasiveLineSchema),  icuController.invasiveLine);
icuRoute.post('/admission/:admissionId/infusion-pump',  authenticate, validate(icuValidation.infusionPumpSchema),  icuController.infusionPump);
icuRoute.post('/admission/:admissionId/severity-scores',authenticate, validate(icuValidation.severityScoreSchema), icuController.severityScore);

icuRoute.get('/admission/:admissionId/fluid-balance', authenticate,icuController.getfluidBalance);
icuRoute.get('/admission/:admissionId/abg-vent',       authenticate,icuController.getabgVent);
icuRoute.get('/admission/:admissionId/fast-hug',       authenticate,icuController.getfastHug);
icuRoute.get('/admission/:admissionId/invasive-line',  authenticate,icuController.getinvasiveLine);
icuRoute.get('/admission/:admissionId/infusion-pump',  authenticate,icuController.getinfusionPump);
icuRoute.get('/admission/:admissionId/severity-scores',authenticate,icuController.getseverityScore);
