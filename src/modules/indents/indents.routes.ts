import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './indents.controller';
import {
  raiseIndentSchema,
  confirmIndentSchema,
  approveIndentSchema,
  dispenseIndentSchema,
  returnIndentSchema,
  acknowledgeIndentSchema,
  cancelIndentSchema,
  indentIdParamSchema,
  ttoFromPrescriptionSchema,
  listIndentsQuerySchema,
} from './indents.validation';

export const indentRoutes = Router();

// Reads — visible to both the ward (nurse) and the IP pharmacy.
indentRoutes.get('/', authenticate, validate(listIndentsQuerySchema), controller.listIndents);
indentRoutes.get('/:id', authenticate, validate(indentIdParamSchema), controller.getIndent);

// Ward nurse: raise an indent + acknowledge the delivery (no pharmacy permission).
indentRoutes.post('/', authenticate, validate(raiseIndentSchema), controller.raiseIndent);
// Ward nurse: confirm an auto-created draft (from the doctor's Rx) → raise it to pharmacy.
indentRoutes.patch('/:id/confirm', authenticate, validate(confirmIndentSchema), controller.confirmDraftIndent);
// TTO / discharge meds: raise a full-pack TTO indent from a discharge prescription.
indentRoutes.post('/from-prescription/:prescriptionId/tto', authenticate, validate(ttoFromPrescriptionSchema), controller.createTtoIndent);
indentRoutes.patch('/:id/acknowledge', authenticate, validate(acknowledgeIndentSchema), controller.acknowledgeIndent);
indentRoutes.patch('/:id/cancel', authenticate, validate(cancelIndentSchema), controller.cancelIndent);

// IP pharmacist: approve (credit-gated) → dispense (posts to IP bill) → deliver.
indentRoutes.patch('/:id/approve', authenticate, requirePermission('pharmacy', 'update'), validate(approveIndentSchema), controller.approveIndent);
indentRoutes.patch('/:id/dispense', authenticate, requirePermission('pharmacy', 'create'), validate(dispenseIndentSchema), controller.dispenseIndent);
indentRoutes.patch('/:id/deliver', authenticate, requirePermission('pharmacy', 'update'), validate(indentIdParamSchema), controller.markDelivered);
// IP Return-to-Stock (RTS): ward returns unused meds → restock batch + credit the IP bill.
indentRoutes.post('/:id/return', authenticate, requirePermission('pharmacy', 'update'), validate(returnIndentSchema), controller.returnIndentItems);
