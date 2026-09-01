import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { prisma } from '../../../../src/config/database';

// The gateway client is never reached by these tests, but importing the service
// pulls it in.
vi.mock('../../../../src/config/razorpay', () => ({
  razorpay: { orders: { create: vi.fn() }, payments: { transfer: vi.fn() } },
}));

import { onlinePaymentsService } from '../../../../src/modules/online-payments/online-payments.service';

const captured = (orderId: string, paymentId: string) =>
  JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
  });

describe('Razorpay webhook signature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // tests/setup.ts leaves RAZORPAY_WEBHOOK_SECRET unset, which is exactly the
  // misconfigured deployment this guards against.
  it('refuses every webhook when no secret is configured', async () => {
    // The route carries no authentication — Razorpay calls it from the
    // internet — so with verification skipped, anyone could post
    // `payment.captured` for any order and settle the bill.
    await expect(
      onlinePaymentsService.handleWebhook(captured('order_1', 'pay_1'), 'anything'),
    ).rejects.toThrow(/cannot be verified/i);

    expect(prisma.paymentTransfer.findUnique).not.toHaveBeenCalled();
  });

  it('refuses it even when the caller sends no signature at all', async () => {
    await expect(
      onlinePaymentsService.handleWebhook(captured('order_1', 'pay_1'), ''),
    ).rejects.toThrow(/cannot be verified/i);
  });

  it('does not read the payload before the signature is settled', async () => {
    // Malformed JSON would throw from JSON.parse if parsing came first; the
    // rejection must be about the signature.
    await expect(onlinePaymentsService.handleWebhook('not json at all', 'sig')).rejects.toThrow(
      /cannot be verified/i,
    );
  });
});

describe('Razorpay webhook signature, with a secret configured', () => {
  const SECRET = 'test-webhook-secret';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  });

  /** Import the service fresh, so it reads the env set above. */
  async function freshService() {
    vi.doMock('../../../../src/config/razorpay', () => ({
      razorpay: { orders: { create: vi.fn() }, payments: { transfer: vi.fn() } },
    }));
    const mod = await import('../../../../src/modules/online-payments/online-payments.service');
    return mod.onlinePaymentsService;
  }

  it('refuses a body whose signature does not match', async () => {
    const service = await freshService();
    const body = captured('order_2', 'pay_2');

    await expect(service.handleWebhook(body, 'deadbeef')).rejects.toThrow(/invalid webhook/i);
  });

  it('accepts a correctly signed body', async () => {
    const service = await freshService();
    const body = captured('order_2', 'pay_2');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

    // Unknown order — the handler logs and returns rather than throwing, which
    // is what stops Razorpay retrying forever.
    vi.mocked(prisma.paymentTransfer.findUnique).mockResolvedValue(null);

    await expect(service.handleWebhook(body, sig)).resolves.toBeUndefined();
    expect(prisma.paymentTransfer.findUnique).toHaveBeenCalledWith({
      where: { razorpayOrderId: 'order_2' },
    });
  });

  it('rejects a body that was altered after signing', async () => {
    const service = await freshService();
    const signed = captured('order_2', 'pay_2');
    const sig = crypto.createHmac('sha256', SECRET).update(signed).digest('hex');
    const tampered = captured('order_2', 'pay_ATTACKER');

    await expect(service.handleWebhook(tampered, sig)).rejects.toThrow(/invalid webhook/i);
  });
});
