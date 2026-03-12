import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  idParamSchema,
  registerDonorSchema,
  updateDonorSchema,
  listDonorsSchema,
  donorHistorySchema,
  recordDonationSchema,
  updateDonationSchema,
  listDonationsSchema,
  screenDonationSchema,
  listInventorySchema,
  addBloodUnitSchema,
  updateBloodUnitSchema,
  discardBloodUnitSchema,
  expiringUnitsSchema,
  requestCrossMatchSchema,
  listCrossMatchesSchema,
  completeCrossMatchSchema,
  requestTransfusionSchema,
  listTransfusionsSchema,
  startTransfusionSchema,
  completeTransfusionSchema,
  reportReactionSchema,
} from './blood-bank.validation';
import * as controller from './blood-bank.controller';

export const bloodBankRoutes = Router();

// --- Donors ---
bloodBankRoutes.post('/donors', authenticate, requirePermission('blood_bank', 'create'), validate(registerDonorSchema), controller.registerDonor);
bloodBankRoutes.get('/donors', authenticate, requirePermission('blood_bank', 'read'), validate(listDonorsSchema), controller.getDonors);
bloodBankRoutes.get('/donors/:id', authenticate, requirePermission('blood_bank', 'read'), validate(idParamSchema), controller.getDonorById);
bloodBankRoutes.put('/donors/:id', authenticate, requirePermission('blood_bank', 'update'), validate(updateDonorSchema), controller.updateDonor);
bloodBankRoutes.get('/donors/:id/history', authenticate, requirePermission('blood_bank', 'read'), validate(donorHistorySchema), controller.getDonorHistory);

// --- Donations ---
bloodBankRoutes.post('/donations', authenticate, requirePermission('blood_bank', 'create'), validate(recordDonationSchema), controller.recordDonation);
bloodBankRoutes.get('/donations', authenticate, requirePermission('blood_bank', 'read'), validate(listDonationsSchema), controller.getDonations);
bloodBankRoutes.get('/donations/:id', authenticate, requirePermission('blood_bank', 'read'), validate(idParamSchema), controller.getDonationById);
bloodBankRoutes.put('/donations/:id', authenticate, requirePermission('blood_bank', 'update'), validate(updateDonationSchema), controller.updateDonation);
bloodBankRoutes.patch('/donations/:id/screen', authenticate, requirePermission('blood_bank', 'approve'), validate(screenDonationSchema), controller.screenDonation);

// --- Blood Inventory ---
bloodBankRoutes.get('/inventory', authenticate, requirePermission('blood_bank', 'read'), validate(listInventorySchema), controller.getBloodInventory);
bloodBankRoutes.get('/inventory/by-group', authenticate, requirePermission('blood_bank', 'read'), controller.getBloodInventoryByGroup);
bloodBankRoutes.post('/inventory', authenticate, requirePermission('blood_bank', 'create'), validate(addBloodUnitSchema), controller.addBloodUnit);
bloodBankRoutes.put('/inventory/:id', authenticate, requirePermission('blood_bank', 'update'), validate(updateBloodUnitSchema), controller.updateBloodUnit);
bloodBankRoutes.patch('/inventory/:id/discard', authenticate, requirePermission('blood_bank', 'approve'), validate(discardBloodUnitSchema), controller.discardBloodUnit);
bloodBankRoutes.get('/inventory/expiring', authenticate, requirePermission('blood_bank', 'read'), validate(expiringUnitsSchema), controller.getExpiringUnits);

// --- Cross-Match ---
bloodBankRoutes.post('/cross-match', authenticate, requirePermission('blood_bank', 'create'), validate(requestCrossMatchSchema), controller.requestCrossMatch);
bloodBankRoutes.get('/cross-match', authenticate, requirePermission('blood_bank', 'read'), validate(listCrossMatchesSchema), controller.getCrossMatches);
bloodBankRoutes.get('/cross-match/:id', authenticate, requirePermission('blood_bank', 'read'), validate(idParamSchema), controller.getCrossMatchById);
bloodBankRoutes.patch('/cross-match/:id/complete', authenticate, requirePermission('blood_bank', 'update'), validate(completeCrossMatchSchema), controller.completeCrossMatch);

// --- Transfusions ---
bloodBankRoutes.post('/transfusions', authenticate, requirePermission('blood_bank', 'create'), validate(requestTransfusionSchema), controller.requestTransfusion);
bloodBankRoutes.get('/transfusions', authenticate, requirePermission('blood_bank', 'read'), validate(listTransfusionsSchema), controller.getTransfusions);
bloodBankRoutes.get('/transfusions/:id', authenticate, requirePermission('blood_bank', 'read'), validate(idParamSchema), controller.getTransfusionById);
bloodBankRoutes.patch('/transfusions/:id/start', authenticate, requirePermission('blood_bank', 'update'), validate(startTransfusionSchema), controller.startTransfusion);
bloodBankRoutes.patch('/transfusions/:id/complete', authenticate, requirePermission('blood_bank', 'update'), validate(completeTransfusionSchema), controller.completeTransfusion);
bloodBankRoutes.post('/transfusions/:id/reaction', authenticate, requirePermission('blood_bank', 'create'), validate(reportReactionSchema), controller.reportReaction);
