import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { uploadSingle } from '../../services/upload.service';
import { AuthenticatedRequest } from '../../shared/types';
import * as controller from './ndps.controller';
import {
  createLocationSchema,
  receiveConsignmentSchema,
  consumptionSchema,
  disposalSchema,
  dailyCloseSchema,
  verifyDailySchema,
  stockQuerySchema,
  registerQuerySchema,
  patientResidualQuerySchema,
  destroyPatientResidualSchema,
} from './ndps.validation';

export const ndpsRoutes = Router();

// Locations (vault + sub-store carts).
ndpsRoutes.get('/locations', authenticate, requirePermission('pharmacy', 'read'), controller.listLocations);
ndpsRoutes.post('/locations', authenticate, requirePermission('pharmacy', 'create'), validate(createLocationSchema), controller.createLocation);

// Lifecycle: Form 3C inward → transfer (challan) → Form 3E consumption → disposal.
ndpsRoutes.post('/consignments', authenticate, requirePermission('pharmacy', 'create'), validate(receiveConsignmentSchema), controller.receiveConsignment);
// POST /transfers is gone. Moving a narcotic is a stock transfer like any
// other and goes through /inventory/transfers, which applies the same
// dual-custody rule. This route wrote the pre-unification NdpsStockBalance
// ledger, so leaving it would have let the two disagree about the same stock.
ndpsRoutes.post('/consumption', authenticate, requirePermission('pharmacy', 'create'), validate(consumptionSchema), controller.recordConsumption);
ndpsRoutes.post('/disposals', authenticate, requirePermission('pharmacy', 'create'), validate(disposalSchema), controller.logDisposal);
ndpsRoutes.get(
  '/patient-residuals',
  authenticate,
  requirePermission('pharmacy', 'read'),
  validate(patientResidualQuerySchema),
  controller.listPatientResiduals,
);
ndpsRoutes.post(
  '/patient-residuals/:id/destroy',
  authenticate,
  requirePermission('pharmacy', 'create'),
  validate(destroyPatientResidualSchema),
  controller.destroyPatientResidual,
);
ndpsRoutes.post(
  '/disposals/evidence',
  authenticate,
  requirePermission('pharmacy', 'create'),
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => uploadSingle('file')(req as any, res, next as any),
  controller.uploadEvidence,
);

// Form 3H daily close + sign-off.
ndpsRoutes.post('/daily-close', authenticate, requirePermission('pharmacy', 'create'), validate(dailyCloseSchema), controller.runDailyClose);
ndpsRoutes.patch('/daily-balances/:id/verify', authenticate, requirePermission('pharmacy', 'update'), validate(verifyDailySchema), controller.verifyDailyBalance);

// Inspector Dashboard (read-only): live stock-by-location + statutory registers.
ndpsRoutes.get('/stock-by-location', authenticate, requirePermission('pharmacy', 'read'), validate(stockQuerySchema), controller.getStockByLocation);
ndpsRoutes.get('/register', authenticate, requirePermission('pharmacy', 'read'), validate(registerQuerySchema), controller.getRegister);
ndpsRoutes.get('/register/pdf', authenticate, requirePermission('pharmacy', 'read'), validate(registerQuerySchema), controller.exportRegisterPdf);
ndpsRoutes.get('/daily-balances', authenticate, requirePermission('pharmacy', 'read'), controller.getDailyBalances);
ndpsRoutes.get('/daily-balances/pdf', authenticate, requirePermission('pharmacy', 'read'), controller.exportDailyPdf);
