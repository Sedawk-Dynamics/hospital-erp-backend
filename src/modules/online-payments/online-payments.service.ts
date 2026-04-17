import crypto from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { AppError } from '../../shared/appError';
import { commissionService } from '../commission/commission.service';
import { VerifyOnlinePaymentInput } from './online-payments.validation';

async function createOnlineOrder(tenantId: string, userId: string, data: { billId: string }) {
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
    include: { patient: true },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'pending' && bill.status !== 'partially_paid') {
    throw AppError.badRequest('Bill is not payable');
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

  if (!tenant?.linkedAccountId || !tenant.bankVerified) {
    throw AppError.badRequest('Hospital bank account not linked. Online payment unavailable.');
  }

  const amount = Number(bill.balanceDue);
  if (amount <= 0) {
    throw AppError.badRequest('No balance due');
  }

  const commissionPercent = await commissionService.getCommissionForTenant(tenantId);

  const commissionAmount = Math.round((amount * commissionPercent / 100) * 100) / 100;
  const hospitalAmount = Math.round((amount - commissionAmount) * 100) / 100;

  const amountInPaise = Math.round(amount * 100);

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `bill_${data.billId.slice(0, 8)}_${Date.now()}`,
    notes: {
      tenantId,
      billId: data.billId,
      commissionPercent: String(commissionPercent),
    },
  });

  const payment = await prisma.payment.create({
    data: {
      tenantId,
      billId: data.billId,
      patientId: bill.patientId,
      paymentDate: new Date(),
      amount,
      paymentMethod: 'upi',
      paymentSource: 'online',
      paymentType: 'regular',
      status: 'pending',
      processedBy: userId,
      gatewayReference: order.id,
      notes: 'Online payment via Razorpay',
    },
  });

  await prisma.paymentTransfer.create({
    data: {
      tenantId,
      paymentId: payment.id,
      razorpayOrderId: order.id,
      totalAmount: amount,
      commissionAmount,
      hospitalAmount,
      commissionPercent,
      transferStatus: 'pending',
    },
  });

  return {
    orderId: order.id,
    amount: amountInPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    paymentId: payment.id,
  };
}

async function verifyOnlinePayment(data: VerifyOnlinePaymentInput) {
  const body = data.razorpay_order_id + '|' + data.razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== data.razorpay_signature) {
    throw AppError.badRequest('Payment verification failed: Invalid signature');
  }

  const transfer = await prisma.paymentTransfer.findUnique({
    where: { razorpayOrderId: data.razorpay_order_id },
  });

  if (!transfer) {
    throw AppError.notFound('Payment transfer not found');
  }

  await prisma.paymentTransfer.update({
    where: { id: transfer.id },
    data: { razorpayPaymentId: data.razorpay_payment_id },
  });

  return { verified: true, transferId: transfer.id };
}

async function handleWebhook(rawBody: string, signature: string) {
  if (env.RAZORPAY_WEBHOOK_SECRET) {
    const expectedSig = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (expectedSig !== signature) {
      throw AppError.unauthorized('Invalid webhook signature');
    }
  }

  const payload = JSON.parse(rawBody);
  const event = payload.event;

  switch (event) {
    case 'payment.captured': {
      const rzpPayment = payload.payload.payment.entity;
      const orderId = rzpPayment.order_id;

      const transfer = await prisma.paymentTransfer.findUnique({
        where: { razorpayOrderId: orderId },
      });

      if (!transfer) {
        logger.warn({ orderId }, 'No transfer found for captured payment');
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: transfer.paymentId },
          data: { status: 'completed', transactionId: rzpPayment.id },
        });

        const payment = await tx.payment.findUnique({ where: { id: transfer.paymentId } });
        const bill = await tx.bill.findUnique({ where: { id: payment!.billId } });

        if (bill) {
          const newAmountPaid = Number(bill.amountPaid) + Number(transfer.totalAmount);
          const newBalanceDue = Number(bill.totalAmount) - Number(bill.discountAmount) - newAmountPaid;
          const newStatus = newBalanceDue <= 0 ? 'paid' : 'partially_paid';

          await tx.bill.update({
            where: { id: bill.id },
            data: {
              amountPaid: newAmountPaid,
              balanceDue: Math.max(0, newBalanceDue),
              status: newStatus,
            },
          });
        }

        await tx.paymentTransfer.update({
          where: { id: transfer.id },
          data: { razorpayPaymentId: rzpPayment.id, webhookPayload: payload },
        });
      });

      // Initiate transfer to hospital's linked account
      const tenant = await prisma.tenant.findUnique({ where: { id: transfer.tenantId } });

      if (tenant?.linkedAccountId) {
        try {
          const hospitalAmountPaise = Math.round(Number(transfer.hospitalAmount) * 100);

          const rzpTransfer = await (razorpay.payments as any).transfer(rzpPayment.id, {
            transfers: [
              {
                account: tenant.linkedAccountId,
                amount: hospitalAmountPaise,
                currency: 'INR',
                notes: {
                  tenantId: transfer.tenantId,
                  paymentTransferId: transfer.id,
                },
              },
            ],
          });

          const transferId = rzpTransfer?.items?.[0]?.id || rzpTransfer?.id;

          await prisma.paymentTransfer.update({
            where: { id: transfer.id },
            data: { razorpayTransferId: transferId, transferStatus: 'processed' },
          });

          logger.info({ transferId, tenantId: transfer.tenantId }, 'Razorpay transfer initiated');
        } catch (err) {
          logger.error({ err, transferId: transfer.id }, 'Failed to initiate Razorpay transfer');

          await prisma.paymentTransfer.update({
            where: { id: transfer.id },
            data: {
              transferStatus: 'failed',
              failureReason: (err as Error).message,
            },
          });
        }
      }

      break;
    }

    case 'transfer.processed': {
      const rzpTransfer = payload.payload.transfer.entity;

      await prisma.paymentTransfer.updateMany({
        where: { razorpayTransferId: rzpTransfer.id },
        data: { transferStatus: 'processed', webhookPayload: payload },
      });

      break;
    }

    case 'transfer.failed': {
      const rzpTransfer = payload.payload.transfer.entity;

      await prisma.paymentTransfer.updateMany({
        where: { razorpayTransferId: rzpTransfer.id },
        data: {
          transferStatus: 'failed',
          failureReason: rzpTransfer.error?.description || 'Transfer failed',
          webhookPayload: payload,
        },
      });

      break;
    }

    case 'payment.failed': {
      const rzpPayment = payload.payload.payment.entity;
      const orderId = rzpPayment.order_id;

      const transfer = await prisma.paymentTransfer.findUnique({
        where: { razorpayOrderId: orderId },
      });

      if (transfer) {
        await prisma.payment.update({
          where: { id: transfer.paymentId },
          data: { status: 'failed' },
        });

        await prisma.paymentTransfer.update({
          where: { id: transfer.id },
          data: {
            transferStatus: 'failed',
            failureReason: 'Payment failed',
            webhookPayload: payload,
          },
        });
      }

      break;
    }
  }

  logger.info({ event }, 'Razorpay webhook processed');
}

export const onlinePaymentsService = {
  createOnlineOrder,
  verifyOnlinePayment,
  handleWebhook,
};
