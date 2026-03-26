import { Request, Response, NextFunction } from 'express';
import { SubscriptionsService } from './subscriptions.service';
import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';

export class SubscriptionsController {
  private service = new SubscriptionsService();

  listPlans = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const plans = await this.service.listActivePlans();
      sendResponse({ res, message: 'Subscription plans retrieved', data: plans });
    } catch (error) { next(error); }
  };

  listAllPlans = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const plans = await this.service.listAllPlans();
      sendResponse({ res, message: 'All subscription plans retrieved', data: plans });
    } catch (error) { next(error); }
  };

  listAllSubscriptions = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const subscriptions = await this.service.listAllSubscriptions();
      sendResponse({ res, message: 'All subscriptions retrieved', data: subscriptions });
    } catch (error) { next(error); }
  };

  createPlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const plan = await this.service.createPlan(req.body);
      sendResponse({ res, statusCode: 201, message: 'Subscription plan created', data: plan });
    } catch (error) { next(error); }
  };

  updatePlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const plan = await this.service.updatePlan(req.params.id as string, req.body);
      sendResponse({ res, message: 'Subscription plan updated', data: plan });
    } catch (error) { next(error); }
  };

  // Manual payment flow
  createOrder = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { planId, billingCycle } = req.body;
      const result = await this.service.createOrder(req.user!.userId, planId, billingCycle);
      sendResponse({ res, statusCode: 201, message: 'Razorpay order created', data: result });
    } catch (error) { next(error); }
  };

  verifyPayment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.verifyPayment(req.user!.userId, req.body);
      sendResponse({ res, message: 'Payment verified and subscription activated', data: result });
    } catch (error) { next(error); }
  };

  // AutoPay flow
  createAutoPaySubscription = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { planId, billingCycle } = req.body;
      const result = await this.service.createAutoPaySubscription(req.user!.userId, planId, billingCycle);
      sendResponse({ res, statusCode: 201, message: 'AutoPay subscription created', data: result });
    } catch (error) { next(error); }
  };

  // Subscription webhook (no auth)
  handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      if (!signature) {
        res.status(400).json({ error: 'Missing signature' });
        return;
      }
      await this.service.handleSubscriptionWebhook(req.body, signature);
      res.status(200).json({ status: 'ok' });
    } catch (error) { next(error); }
  };

  // Plan change (upgrade/downgrade)
  changePlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { planId, billingCycle, paymentMethod } = req.body;
      const result = await this.service.changePlan(req.user!.userId, planId, billingCycle, paymentMethod);
      sendResponse({ res, message: 'Plan changed successfully', data: result });
    } catch (error) { next(error); }
  };

  // User management
  getMySubscription = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.getMySubscription(req.user!.userId);
      sendResponse({ res, message: 'Subscription status retrieved', data: result });
    } catch (error) { next(error); }
  };

  cancelSubscription = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.cancelSubscription(req.user!.userId);
      sendResponse({ res, message: result.message, data: result });
    } catch (error) { next(error); }
  };

  turnOffAutoRenew = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.turnOffAutoRenew(req.user!.userId);
      sendResponse({ res, message: result.message, data: result });
    } catch (error) { next(error); }
  };

  listPlanAssignments = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const assignments = await this.service.listPlanAssignments();
      sendResponse({ res, message: 'Plan assignments retrieved', data: assignments });
    } catch (error) { next(error); }
  };

  getOfferedPlans = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const plans = await this.service.getOfferedPlans(req.user!.userId);
      sendResponse({ res, message: 'Offered plans retrieved', data: plans });
    } catch (error) { next(error); }
  };

  getPaymentHistory = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payments = await this.service.getPaymentHistory(req.user!.userId);
      sendResponse({ res, message: 'Payment history retrieved', data: payments });
    } catch (error) { next(error); }
  };

  // Super admin: offer plans to user
  adminAssignPlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.adminAssignPlan(req.body);
      const planNames = result.plans.map((p) => p.name).join(', ');
      sendResponse({
        res,
        statusCode: 201,
        message: `Plans (${planNames}) offered to ${result.user.firstName} ${result.user.lastName}`,
        data: result,
      });
    } catch (error) { next(error); }
  };

  // Dev helper
  devActivateSubscription = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, planId, days } = req.body;
      const result = await this.service.devActivateSubscription(userId, planId, days || 30);
      sendResponse({ res, message: 'Subscription activated (dev mode)', data: result });
    } catch (error) { next(error); }
  };
}
