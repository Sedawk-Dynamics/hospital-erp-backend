import crypto from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { LinkBankAccountInput } from './bank-linking.validation';

/**
 * Link a bank account to a tenant via Razorpay Route API.
 * In development/test mode, falls back to a placeholder if Route API is unavailable.
 */
export async function linkBankAccount(
  tenantId: string,
  userId: string,
  data: LinkBankAccountInput,
) {
  // 1. Fetch tenant and verify it exists and is active
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isActive: true,
      linkedAccountId: true,
    },
  });

  if (!tenant) {
    throw AppError.notFound('Tenant not found');
  }

  if (!tenant.isActive) {
    throw AppError.badRequest('Tenant is not active');
  }

  // 2. Check if already linked
  if (tenant.linkedAccountId) {
    throw AppError.conflict('Bank account already linked. Please unlink first to re-link.');
  }

  // 3. Call Razorpay Route API - Create Linked Account
  const accountData = {
    email: tenant.email || data.accountHolderName.toLowerCase().replace(/\s+/g, '') + '@hospital.com',
    phone: tenant.phone || '9999999999',
    type: 'route',
    legal_business_name: data.legalBusinessName,
    business_type: data.businessType,
    legal_info: {
      pan: data.panNumber,
      ...(data.gstNumber ? { gst: data.gstNumber } : {}),
    },
    bank_account: {
      beneficiary_name: data.accountHolderName,
      ifsc_code: data.ifscCode,
      account_type: 'current',
      account_number: data.accountNumber,
    },
  };

  let linkedAccountId: string;
  try {
    const account = await (razorpay as any).accounts.create(accountData);
    linkedAccountId = account.id;
  } catch (error: unknown) {
    // In development/test mode, generate a placeholder linked account ID
    // so the flow can be tested without Razorpay Route API access
    if (env.NODE_ENV !== 'production') {
      linkedAccountId = `acc_dev_${crypto.randomBytes(8).toString('hex')}`;
      logger.warn(
        { tenantId, linkedAccountId },
        'Razorpay Route API unavailable — using dev placeholder linked account',
      );
    } else {
      const msg =
        (error as any)?.error?.description ||
        (error as Error)?.message ||
        'Failed to create linked account';
      logger.error({ err: error, tenantId }, 'Razorpay linked account creation failed');
      throw AppError.badRequest(`Bank linking failed: ${msg}`);
    }
  }

  // 4. Update tenant with linked account info
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      linkedAccountId,
      bankVerified: true,
    },
  });

  // 5. Log success (do NOT log bank details, only tenantId and linkedAccountId)
  logger.info({ tenantId, linkedAccountId, userId }, 'Bank account linked successfully');

  // 6. Return result
  return { linkedAccountId, bankVerified: true };
}

/**
 * Get the bank link status for a tenant.
 */
export async function getBankLinkStatus(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      linkedAccountId: true,
      bankVerified: true,
      name: true,
    },
  });

  if (!tenant) {
    throw AppError.notFound('Tenant not found');
  }

  return {
    linkedAccountId: tenant.linkedAccountId,
    bankVerified: tenant.bankVerified,
    hospitalName: tenant.name,
  };
}

/**
 * Unlink a bank account from a tenant.
 */
export async function unlinkBankAccount(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      linkedAccountId: true,
    },
  });

  if (!tenant) {
    throw AppError.notFound('Tenant not found');
  }

  if (!tenant.linkedAccountId) {
    throw AppError.badRequest('No bank account is currently linked');
  }

  // Update tenant to remove linked account
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      linkedAccountId: null,
      bankVerified: false,
    },
  });

  logger.info({ tenantId }, 'Bank account unlinked successfully');

  return { success: true };
}
