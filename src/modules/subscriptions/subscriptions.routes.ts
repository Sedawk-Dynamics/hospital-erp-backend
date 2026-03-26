import { Router } from 'express';
import { SubscriptionsController } from './subscriptions.controller';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';

const router = Router();
const controller = new SubscriptionsController();

// ─── Webhook (no auth, raw body handled in app.ts) ──────────
router.post('/webhook', controller.handleWebhook);

// ─── Public ─────────────────────────────────────────────────
router.get('/', controller.listPlans);

// ─── Authenticated (any logged-in user) ─────────────────────
router.post('/create-order', authenticate, controller.createOrder);
router.post('/verify-payment', authenticate, controller.verifyPayment);
router.post('/create-autopay', authenticate, controller.createAutoPaySubscription);
router.post('/change-plan', authenticate, controller.changePlan);
router.get('/my-subscription', authenticate, controller.getMySubscription);
router.post('/cancel', authenticate, controller.cancelSubscription);
router.post('/turn-off-auto-renew', authenticate, controller.turnOffAutoRenew);
router.get('/offered-plans', authenticate, controller.getOfferedPlans);
router.get('/payment-history', authenticate, controller.getPaymentHistory);

// ─── Super admin only ───────────────────────────────────────
router.get('/all', authenticate, requireRoles('super_admin'), controller.listAllPlans);
router.get('/admin/all-subscriptions', authenticate, requireRoles('super_admin'), controller.listAllSubscriptions);
router.post('/plans', authenticate, requireRoles('super_admin'), controller.createPlan);
router.put('/plans/:id', authenticate, requireRoles('super_admin'), controller.updatePlan);
router.post('/admin/assign-plan', authenticate, requireRoles('super_admin'), controller.adminAssignPlan);
router.get('/admin/plan-assignments', authenticate, requireRoles('super_admin'), controller.listPlanAssignments);
router.post('/dev/activate', authenticate, requireRoles('super_admin'), controller.devActivateSubscription);

export { router as subscriptionPlanRoutes };
