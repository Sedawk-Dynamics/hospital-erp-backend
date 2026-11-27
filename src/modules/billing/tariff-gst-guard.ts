import type { NextFunction, Response } from 'express';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import type { AuthenticatedRequest } from '../../shared/types';

// #264: a service's GST classification, and whether it can be billed at all,
// belong to the users with the GST settings right. The tariff routes are also
// open to anyone with billing:update (the front desk and cashier edit prices),
// so without this the front desk could change a service's SAC or rate, which
// bills use straight away, or switch the service off.

/** Fields that only a GST manager may send. */
export const TARIFF_GST_FIELDS = [
  'sacCode', 'gstTreatment', 'taxRate', 'isCosmetic', 'gstEffectiveFrom', 'gstChangeReason', 'isActive',
] as const;

export const TARIFF_GST_ROLES = ['super_admin', 'admin', 'billing_admin'] as const;

/**
 * The radiology admin keeps the scans: it sets a study's SAC and cosmetic flag
 * and switches studies on and off in Radiology settings. A scan's GST still
 * waits for finance's approval before it applies (#358).
 */
const SCAN_ROLES = ['radiology_admin'];
const isScan = (category: unknown) => ['imaging', 'radiology'].includes(String(category ?? '').toLowerCase());

export function guardTariffGstFields(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // A new service starts active; only switching it later is an on/off change.
  const creating = !req.params?.id;
  const sent = TARIFF_GST_FIELDS.filter((f) => body[f] !== undefined && !(creating && f === 'isActive' && body[f] === true));
  const roles = req.user?.roles ?? [];
  if (!sent.length || roles.some((r) => (TARIFF_GST_ROLES as readonly string[]).includes(r))) return next();

  const refuse = () =>
    next(
      AppError.forbidden(
        'Only the Hospital Admin or Billing Admin can change a service’s GST classification or switch it on or off. ' +
          'Ask them to do it in Settings → GST classification.',
      ),
    );
  if (!roles.some((r) => SCAN_ROLES.includes(r))) return refuse();

  // A radiology admin: allowed only on a scan, and a service cannot be turned
  // into a scan to get round it.
  const id = req.params?.id as string | undefined;
  const check = async () => {
    if (body.category !== undefined && !isScan(body.category)) return false;
    if (!id) return isScan(body.category);
    const tariff = await prisma.serviceTariff.findFirst({
      where: { id, tenantId: req.user!.tenantId },
      select: { category: true },
    });
    return !tariff || isScan(tariff.category);
  };
  check().then((ok) => (ok ? next() : refuse()), next);
}
