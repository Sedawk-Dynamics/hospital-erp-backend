import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { istDayRange, istDayStart, istDayEnd } from '../../shared/date.utils';
import {
  billDiagnosticOrder,
  resolveDiagnosticPayer,
  createPayment,
  type DiagnosticChargeInput,
} from '../billing/billing.service';
import type {
  CreateImagingRequestInput,
  AcceptImagingRequestInput,
  UpdateImagingRequestInput,
  GetImagingRequestsQuery,
  ScheduleImagingInput,
  CloseImagingRequestInput,
  UploadImagingResultInput,
  GetImagingResultsQuery,
  AddImagingReportInput,
} from './imaging.validation';

// Best-effort notification (failures don't break workflow)
async function safeNotify(params: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  notificationType?: 'lab_result' | 'general' | 'alert';
  referenceType?: string;
  referenceId?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title,
        message: params.message,
        notificationType: params.notificationType ?? 'general',
        channel: 'in_app',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to dispatch imaging notification');
    return;
  }
}

/**
 * Ping every radiology admin in the tenant — used when a radiologist marks a
 * study done so the approval queue does not depend on somebody refreshing.
 * Mirrors the lab's notifyLabSupervisors.
 */
async function notifyRadiologyAdmins(
  tenantId: string,
  title: string,
  message: string,
  referenceType: string,
  referenceId: string,
) {
  try {
    const admins = await prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: { some: { role: { name: 'radiology_admin' } } },
      },
      select: { id: true },
    });
    await Promise.all(
      admins.map((a) =>
        safeNotify({
          tenantId,
          userId: a.id,
          title,
          message,
          notificationType: 'general',
          referenceType,
          referenceId,
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, tenantId }, 'Failed to notify radiology admins');
  }
}

/**
 * Roles that work INSIDE radiology and therefore see a study before it is
 * approved. Everyone else — the ordering doctor, nurses, the ward — sees the
 * request but not its unreleased contents, exactly as the lab already does
 * with an unpublished report.
 */
const RADIOLOGY_INSIDER_ROLES = new Set([
  'radiologist',
  'radiology_admin',
  'admin',
  'super_admin',
]);

export function isImagingReportReleased(status?: string | null): boolean {
  return status === 'published';
}

// Resolve a tariff price for a given imaging type (best-effort lookup against ServiceTariff).
// Resolution order, most specific first:
//   1. A study-specific tariff whose name matches the body part (e.g. "MRI Brain").
//   2. The per-modality base price the admin set in Radiology → Settings, keyed
//      by serviceCode = the imaging type (e.g. serviceCode='ct_scan').
//   3. A loose name-contains match on the modality.
async function lookupImagingPrice(tenantId: string, imagingType: string, bodyPart?: string | null) {
  try {
    if (bodyPart) {
      const specific = await prisma.serviceTariff.findFirst({
        where: {
          tenantId,
          category: 'radiology',
          isActive: true,
          serviceName: { contains: bodyPart, mode: 'insensitive' },
        },
      });
      if (specific) return { id: specific.id, price: Number(specific.basePrice ?? 0) };
    }

    const byModality = await prisma.serviceTariff.findFirst({
      where: {
        tenantId,
        category: 'radiology',
        isActive: true,
        serviceCode: { equals: imagingType, mode: 'insensitive' },
      },
    });
    if (byModality) return { id: byModality.id, price: Number(byModality.basePrice ?? 0) };

    const byName = await prisma.serviceTariff.findFirst({
      where: {
        tenantId,
        category: 'radiology',
        isActive: true,
        serviceName: { contains: imagingType, mode: 'insensitive' },
      },
    });
    if (byName) return { id: byName.id, price: Number(byName.basePrice ?? 0) };
  } catch {}
  return { id: null as string | null, price: 0 };
}

// Imaging service catalog — the imaging (category=radiology) tariffs the
// radiology admin maintains in Settings, surfaced as a searchable catalog for
// the doctor's order dialog (mirrors the lab test catalog). Returns active
// services with their modality so a pick routes to the right ImagingType.
export async function getImagingCatalog(
  tenantId: string,
  query: { search?: string; modality?: string; limit?: number },
) {
  const where: any = { tenantId, category: 'radiology', isActive: true };
  if (query.modality) where.modality = query.modality;
  if (query.search) {
    where.OR = [
      { serviceName: { contains: query.search, mode: 'insensitive' } },
      { serviceCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  const items = await prisma.serviceTariff.findMany({
    where,
    orderBy: { serviceName: 'asc' },
    take: Math.min(query.limit ?? 30, 100),
    select: {
      id: true,
      serviceName: true,
      serviceCode: true,
      basePrice: true,
      gstRatePercent: true,
      modality: true,
      isActive: true,
    },
  });
  return items.map((i) => ({
    ...i,
    basePrice: Number(i.basePrice ?? 0),
    gstRatePercent: Number(i.gstRatePercent ?? 0),
  }));
}

/**
 * Price a study as a billable line. When the doctor ordered it off the catalog,
 * `preferredTariffId` prices it exactly off that tariff; otherwise fall back to
 * the modality / body-part lookup.
 */
async function buildImagingCharge(
  tenantId: string,
  requestId: string,
  preferredTariffId?: string | null,
) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  if (!request) return null;

  let serviceTariffId: string | null = null;
  let price = 0;
  if (preferredTariffId) {
    const picked = await prisma.serviceTariff.findFirst({
      where: { id: preferredTariffId, tenantId, category: 'radiology', isActive: true },
    });
    if (picked) {
      serviceTariffId = picked.id;
      price = Number(picked.basePrice ?? 0);
    }
  }
  if (!serviceTariffId) {
    const resolved = await lookupImagingPrice(tenantId, request.imagingType, request.bodyPart);
    serviceTariffId = resolved.id;
    price = resolved.price;
  }

  const charge: DiagnosticChargeInput = {
    referenceType: 'imaging_request',
    referenceId: requestId,
    description: `${request.imagingType.toUpperCase()}${request.bodyPart ? ' — ' + request.bodyPart : ''}`,
    quantity: 1,
    unitPrice: price,
    serviceTariffId,
  };
  return { request, charge };
}

/**
 * Post a study's charge to wherever the patient settles: radiology's own
 * counter bill for an OP patient, the admission's running ledger for an
 * IP / Emergency / Day Care one. Globally idempotent — safe to call twice.
 *
 * Same rule, same helper, as the lab side.
 */
export async function autoLinkImagingToBill(
  tenantId: string,
  requestId: string,
  preferredTariffId?: string | null,
  userId?: string,
) {
  try {
    const built = await buildImagingCharge(tenantId, requestId, preferredTariffId);
    if (!built || built.charge.unitPrice <= 0) return null;
    return await billDiagnosticOrder(tenantId, userId ?? built.request.orderedBy, {
      source: 'imaging',
      patientId: built.request.patientId,
      visitId: built.request.visitId,
      charges: [built.charge],
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'Failed to auto-link imaging request to bill');
    return null;
  }
}

/** Read-only preview for the accept dialog — mirrors getLabOrderBillingPreview. */
export async function getImagingBillingPreview(tenantId: string, requestId: string) {
  const built = await buildImagingCharge(tenantId, requestId);
  if (!built) throw AppError.notFound('Imaging request not found');

  const payer = await resolveDiagnosticPayer(
    tenantId,
    built.request.patientId,
    built.request.visitId,
  );

  const existing = await prisma.billItem.findFirst({
    where: {
      referenceType: 'imaging_request',
      referenceId: requestId,
      bill: { tenantId, status: { not: 'cancelled' } },
    },
    select: {
      bill: {
        select: { id: true, billNumber: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true },
      },
    },
  });

  return {
    requestId,
    mode: payer.mode,
    admissionId: payer.admissionId,
    admissionType: payer.admissionType,
    lines: [
      {
        referenceId: requestId,
        description: built.charge.description,
        amount: built.charge.unitPrice,
      },
    ],
    chargeAmount: built.charge.unitPrice,
    unpricedCount: built.charge.unitPrice > 0 ? 0 : 1,
    alreadyBilled: !!existing?.bill,
    bill: existing?.bill
      ? {
          id: existing.bill.id,
          billNumber: existing.bill.billNumber,
          status: existing.bill.status,
          totalAmount: Number(existing.bill.totalAmount ?? 0),
          amountPaid: Number(existing.bill.amountPaid ?? 0),
          balanceDue: Number(existing.bill.balanceDue ?? 0),
        }
      : null,
  };
}

// ============================================================
// Imaging Requests
// ============================================================

export async function createImagingRequest(
  tenantId: string,
  userId: string,
  data: CreateImagingRequestInput,
) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit exists
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  const request = await prisma.imagingRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      orderedBy: userId,
      imagingType: data.imagingType,
      bodyPart: data.bodyPart,
      urgency: data.urgency,
      clinicalIndication: data.clinicalIndication,
      notes: data.notes,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: request.id }, 'Imaging request created');

  // NOT billed here — the charge is posted when RADIOLOGY ACCEPTS the study.
  // Billing on the doctor's click put a line on the patient's bill for a scan
  // the department had not yet agreed to do. The tariff the doctor picked is
  // remembered on the request's notes-free path via the accept step, which
  // re-resolves it from the modality/body part.
  return request;
}

/**
 * Accept an imaging request — the radiology admin's single act at their own
 * counter. Identical in shape to acceptLabOrder: charge, settle, admit, assign.
 *
 * Replaces the bare "Verify Payment" flag, which recorded that somebody had
 * looked at a bill without taking any money or moving the study anywhere.
 */
export async function acceptImagingRequest(
  tenantId: string,
  id: string,
  acceptorUserId: string,
  data: AcceptImagingRequestInput,
) {
  const request = await prisma.imagingRequest.findFirst({ where: { id, tenantId } });
  if (!request) throw AppError.notFound('Imaging request not found');
  if (request.status === 'cancelled' || request.status === 'no_show') {
    throw AppError.badRequest('Cannot accept a closed request — reopen it first');
  }
  if (request.status === 'completed') {
    throw AppError.badRequest('Cannot accept a completed request');
  }

  if (data.assignedTechnicianId) {
    const person = await prisma.user.findFirst({
      where: { id: data.assignedTechnicianId, tenantId, isActive: true },
    });
    if (!person) throw AppError.badRequest('Assigned user not found in tenant');
  }

  // 1 — charge.
  const billing = await autoLinkImagingToBill(
    tenantId,
    id,
    data.serviceTariffId ?? null,
    acceptorUserId,
  );

  // 2 — settle.
  let paymentVerified = request.paymentVerified;
  let deferredReason: string | null = request.paymentDeferredReason;

  if (billing?.mode === 'ip') {
    paymentVerified = true;
    deferredReason = null;
  } else if (data.payment) {
    if (!billing?.billId) {
      throw AppError.badRequest('There is nothing to collect on this request.');
    }
    const due = billing.balanceDue ?? 0;
    if (due <= 0) {
      paymentVerified = true;
      deferredReason = null;
    } else {
      const amount = Math.min(data.payment.amount ?? due, due);
      if (amount <= 0) throw AppError.badRequest('Enter an amount to collect');
      await createPayment(tenantId, acceptorUserId, {
        billId: billing.billId,
        amount,
        paymentMethod: data.payment.paymentMethod,
        referenceNumber: data.payment.referenceNumber,
        notes: data.payment.notes,
      } as any);
      const after = await prisma.bill.findUnique({
        where: { id: billing.billId },
        select: { balanceDue: true },
      });
      paymentVerified = Number(after?.balanceDue ?? 0) <= 0;
      deferredReason = paymentVerified ? null : (data.deferReason?.trim() || 'Part payment collected');
    }
  } else if (data.deferReason) {
    paymentVerified = false;
    deferredReason = data.deferReason.trim();
  } else if (billing?.billId && (billing.balanceDue ?? 0) <= 0) {
    paymentVerified = true;
    deferredReason = null;
  } else if (!billing) {
    // Nothing to charge (no tariff priced for this modality) — accepting must
    // not be blocked by a catalog gap.
    paymentVerified = true;
    deferredReason = null;
  }

  // 3 — admit + assign.
  const now = new Date();
  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      acceptedAt: now,
      acceptedBy: acceptorUserId,
      assignedTechnicianId: data.assignedTechnicianId ?? request.assignedTechnicianId,
      paymentVerified,
      paymentVerifiedBy: paymentVerified ? (request.paymentVerifiedBy ?? acceptorUserId) : null,
      paymentVerifiedAt: paymentVerified ? (request.paymentVerifiedAt ?? now) : null,
      paymentDeferredReason: deferredReason,
      notes: data.notes ?? request.notes,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      acceptedByUser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (data.assignedTechnicianId && data.assignedTechnicianId !== request.assignedTechnicianId) {
    await safeNotify({
      tenantId,
      userId: data.assignedTechnicianId,
      title: 'Imaging study assigned to you',
      message: `${updated.patient.firstName} ${updated.patient.lastName ?? ''} — ${updated.imagingType.toUpperCase()}${updated.bodyPart ? ` ${updated.bodyPart}` : ''}.`.trim(),
      notificationType: 'general',
      referenceType: 'imaging_request',
      referenceId: id,
    });
  }
  await safeNotify({
    tenantId,
    userId: updated.orderedBy,
    title: 'Imaging request accepted',
    message: `Radiology has accepted ${updated.imagingType.toUpperCase()}${updated.bodyPart ? ' — ' + updated.bodyPart : ''}.`,
    notificationType: 'general',
    referenceType: 'imaging_request',
    referenceId: id,
  });

  logger.info(
    { tenantId, imagingRequestId: id, mode: billing?.mode, paymentVerified },
    'Imaging request accepted',
  );
  return { ...updated, billing };
}

/**
 * Still open more than 24 hours after it was raised, with nothing published.
 *
 * Declared once — the dashboard count and the `overdue=true` filter both use it,
 * so the number on the card and the rows underneath it cannot disagree. Same
 * shape as the lab's OVERDUE_WHERE.
 */
export const IMAGING_OVERDUE_WHERE = (tenantId: string, before: Date) => ({
  tenantId,
  status: { notIn: ['completed', 'cancelled', 'no_show'] as any },
  createdAt: { lt: before },
  OR: [{ imagingResult: null }, { imagingResult: { status: { not: 'published' as any } } }],
});

export async function getImagingRequests(
  tenantId: string,
  query: GetImagingRequestsQuery,
  actorRoles: string[] = [],
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if ((query as any).closed) {
    // Closed / No-show tab: terminal admin-closed requests in one call.
    where.status = { in: ['cancelled', 'no_show'] };
  } else if ((query as any).statuses) {
    // Several statuses at once — a worklist wants "everything still open",
    // which a single enum cannot express. Same param the lab list takes.
    const list = String((query as any).statuses)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length) where.status = { in: list as any };
  } else if (query.status) {
    where.status = query.status;
  } else {
    // Radiology module hides cancelled + no-show requests from its active
    // queues/dashboard (they live in the dedicated Closed tab). The Pending
    // worklist additionally excludes completed so it shows only the to-do set.
    const excluded: string[] = [];
    if ((query as any).excludeCancelled) excluded.push('cancelled', 'no_show');
    if ((query as any).excludeCompleted) excluded.push('completed');
    if (excluded.length) where.status = { notIn: excluded };
  }

  if (query.imagingType) {
    where.imagingType = query.imagingType;
  }

  if (query.urgency) {
    where.urgency = query.urgency;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.assignedTechnicianId) {
    where.assignedTechnicianId = query.assignedTechnicianId;
  }

  // Payment-verify gate (2026-05-27 flow). The radiology_admin queue passes
  // paymentVerified=false; the radiologist queue passes paymentVerified=true.
  if (typeof (query as any).paymentVerified === 'boolean') {
    where.paymentVerified = (query as any).paymentVerified;
  }

  // Accepted / not yet accepted — the admin's intake queue, mirroring the lab.
  if ((query as any).accepted !== undefined) {
    where.acceptedAt = (query as any).accepted ? { not: null } : null;
  }

  // Nobody has picked it up yet.
  if ((query as any).unassigned) {
    where.assignedTechnicianId = null;
  }

  // Whole IST days. This used to bound the day with a bare `new Date(date)`,
  // which is midnight UTC — 05:30 IST — so "today" ran from half past five this
  // morning to half past five tomorrow and moved early-morning studies onto the
  // wrong day. The lab list was fixed for this; radiology had the same bug.
  if (query.date) {
    const { start, end } = istDayRange(query.date);
    where.createdAt = { ...where.createdAt, gte: start, lte: end };
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: istDayEnd(query.toDate) };
  }

  // Past its 24-hour SLA with nothing published. Applied after the status
  // clauses above so it wins — it IS a status statement.
  //
  // Its "not published" clause goes under AND, not OR: the search below also
  // writes `where.OR`, and whichever ran last would silently replace the other.
  if ((query as any).overdue) {
    const { OR: notPublished, ...rest } = IMAGING_OVERDUE_WHERE(
      tenantId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    Object.assign(where, rest);
    where.AND = [...(where.AND ?? []), { OR: notPublished }];
  }

  if (query.search) {
    where.OR = [
      { bodyPart: { contains: query.search, mode: 'insensitive' } },
      { clinicalIndication: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.imagingRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        orderer: { select: { id: true, firstName: true, lastName: true } },
        assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
        paymentVerifier: { select: { id: true, firstName: true, lastName: true } },
        closer: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitType: true } },
        imagingResult: {
          select: {
            id: true,
            status: true,
            pdfReportUrl: true,
            signedAt: true,
          },
        },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.imagingRequest.count({ where }),
  ]);

  // Decorate each request with the linked bill status so the admin can
  // decide whether to verify payment. The auto-link writes a BillItem with
  // referenceType='imaging_request', so look up the parent Bill from that.
  const requestIds = requests.map((r) => r.id);
  const billItems = requestIds.length
    ? await prisma.billItem.findMany({
        where: {
          referenceType: 'imaging_request',
          referenceId: { in: requestIds },
          bill: { tenantId },
        },
        select: {
          referenceId: true,
          totalAmount: true,
          bill: {
            select: {
              id: true,
              billNumber: true,
              status: true,
              admissionId: true,
              amountPaid: true,
              totalAmount: true,
              balanceDue: true,
              // Surface how the patient paid so the admin can confirm the mode
              // at the verify-payment step.
              payments: {
                where: { status: 'completed' },
                select: { paymentMethod: true, amount: true, paymentDate: true },
                orderBy: { paymentDate: 'desc' },
              },
            },
          },
        },
      })
    : [];
  const billByRequestId = new Map<string, (typeof billItems)[number]>();
  for (const bi of billItems) {
    // Multiple bill items per request shouldn't happen (autoLinkImagingToBill
    // is idempotent on referenceType+referenceId), but keep the latest just
    // in case.
    billByRequestId.set(bi.referenceId!, bi);
  }

  // A report the radiology admin has not approved is not a report yet. Outside
  // the department the row still shows — the doctor needs to know their scan is
  // running and can chase it — but the result and its files are withheld and
  // flagged `awaitingApproval`. This is the same rule the lab has applied to
  // unpublished reports since the supervisor gate went in; radiology had no
  // gate at all, so a doctor could open a half-finished study.
  const isInsider = actorRoles.some((r) => RADIOLOGY_INSIDER_ROLES.has(r));

  const decorated = requests.map((r) => {
    const bi = billByRequestId.get(r.id);
    const released = isImagingReportReleased(r.imagingResult?.status);
    return {
      ...r,
      released,
      awaitingApproval: !!r.imagingResult && !released,
      imagingResult: isInsider || released ? r.imagingResult : null,
      linkedBill: bi
        ? {
            id: bi.bill?.id,
            billNumber: bi.bill?.billNumber,
            status: bi.bill?.status,
            // An IP bill is the stay ledger — never collected at this counter.
            isLedger: !!bi.bill?.admissionId,
            amountPaid: bi.bill?.amountPaid,
            totalAmount: bi.bill?.totalAmount,
            balanceDue: bi.bill?.balanceDue,
            chargeAmount: bi.totalAmount,
            payments: (bi.bill?.payments ?? []).map((p) => ({
              paymentMethod: p.paymentMethod,
              amount: p.amount,
              paymentDate: p.paymentDate,
            })),
          }
        : null,
    };
  });

  return { requests: decorated, total, page, limit };
}

export async function getImagingRequestById(tenantId: string, id: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      orderer: { select: { id: true, firstName: true, lastName: true, email: true } },
      visit: { select: { id: true, visitType: true } },
      imagingResult: true,
    },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  return request;
}

export async function updateImagingRequest(
  tenantId: string,
  id: string,
  data: UpdateImagingRequestInput,
) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot update a ${request.status} imaging request`);
  }

  // Validate technician belongs to tenant
  if (data.assignedTechnicianId) {
    const tech = await prisma.user.findFirst({
      where: { id: data.assignedTechnicianId, tenantId, isActive: true },
    });
    if (!tech) throw AppError.badRequest('Assigned technician not found in tenant');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      imagingType: data.imagingType,
      bodyPart: data.bodyPart,
      urgency: data.urgency,
      clinicalIndication: data.clinicalIndication,
      notes: data.notes,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      assignedTechnicianId: data.assignedTechnicianId,
      room: data.room,
      // If a schedule is being set on a 'requested' record, advance it
      ...(data.scheduledAt && request.status === 'requested' ? { status: 'scheduled' } : {}),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request updated');
  return updated;
}

export async function cancelImagingRequest(tenantId: string, id: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'cancelled') {
    throw AppError.badRequest('Imaging request is already cancelled');
  }

  if (request.status === 'completed') {
    throw AppError.badRequest('Cannot cancel a completed imaging request');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: { status: 'cancelled' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request cancelled');
  return updated;
}

// Human-readable closure reason labels (notifications + logs).
const CLOSURE_REASON_LABELS: Record<string, string> = {
  patient_no_show: 'Patient no-show',
  patient_refused: 'Patient refused the procedure',
  patient_cancelled: 'Cancelled by patient',
  done_externally: 'Done at another facility',
  not_required: 'No longer required',
  equipment_unavailable: 'Equipment unavailable',
  duplicate_order: 'Duplicate order',
  other: 'Other',
};

// Radiology admin closes a request that will never produce a report file.
// `patient_no_show` lands the request on the dedicated `no_show` status (a
// standard radiology KPI); every other reason maps to `cancelled` while the
// closureReason column preserves WHY. Records who/when and notifies the
// ordering doctor so they know the study won't be coming back.
export async function closeImagingRequest(
  tenantId: string,
  id: string,
  userId: string,
  data: CloseImagingRequestInput,
) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'completed') {
    throw AppError.badRequest(
      'This study is already completed — close is only for requests with no report file.',
    );
  }
  if (request.status === 'cancelled' || request.status === 'no_show') {
    throw AppError.badRequest(`Imaging request is already closed (${request.status}).`);
  }
  // A draft/finalized result means a file is already attached — don't strand it.
  const existingResult = await prisma.imagingResult.findUnique({
    where: { imagingRequestId: id },
    select: { id: true },
  });
  if (existingResult) {
    throw AppError.badRequest(
      'A result has already been uploaded for this request. Cancel/withdraw the result instead of closing the request.',
    );
  }

  const newStatus = data.reason === 'patient_no_show' ? 'no_show' : 'cancelled';

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      status: newStatus,
      closureReason: data.reason,
      closureNote: data.note,
      closedBy: userId,
      closedAt: new Date(),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      closer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const reasonLabel = CLOSURE_REASON_LABELS[data.reason] ?? data.reason;
  await safeNotify({
    tenantId,
    userId: updated.orderedBy,
    title: 'Imaging request closed',
    message: `${updated.imagingType.toUpperCase()}${updated.bodyPart ? ' — ' + updated.bodyPart : ''} was closed by the radiology desk. Reason: ${reasonLabel}.${data.note ? ' Note: ' + data.note : ''}`,
    notificationType: 'general',
    referenceType: 'imaging_request',
    referenceId: id,
  });

  logger.info(
    { tenantId, imagingRequestId: id, reason: data.reason, status: newStatus, closedBy: userId },
    'Imaging request closed',
  );
  return updated;
}

// Re-activate a closed/no-show request when the patient comes back. Resets it
// to `requested` and clears the closure metadata; paymentVerified is left as
// it was so a previously-paid request goes straight back to the radiologist
// queue without a second payment check.
export async function reopenImagingRequest(tenantId: string, id: string, userId: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status !== 'cancelled' && request.status !== 'no_show') {
    throw AppError.badRequest('Only a closed or no-show request can be reopened.');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      status: 'requested',
      closureReason: null,
      closureNote: null,
      closedBy: null,
      closedAt: null,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  await safeNotify({
    tenantId,
    userId: updated.orderedBy,
    title: 'Imaging request reopened',
    message: `${updated.imagingType.toUpperCase()}${updated.bodyPart ? ' — ' + updated.bodyPart : ''} has been reopened and is back in the radiology worklist.`,
    notificationType: 'general',
    referenceType: 'imaging_request',
    referenceId: id,
  });

  logger.info({ tenantId, imagingRequestId: id, reopenedBy: userId }, 'Imaging request reopened');
  return updated;
}

export async function scheduleImaging(tenantId: string, id: string, data: ScheduleImagingInput) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot schedule a ${request.status} imaging request`);
  }

  // A no-show can be rescheduled directly (patient returned for the scan) —
  // scheduling clears the earlier closure metadata below.

  // Gate: payment must be verified by radiology_admin before the radiologist
  // can schedule the slot. Doctors can still create requests freely; the
  // gate is only at the scheduling boundary.
  if (!request.paymentVerified) {
    throw AppError.badRequest(
      'Payment for this imaging request has not been verified yet. The radiology admin must verify payment before scheduling.',
    );
  }

  if (data.assignedTechnicianId) {
    const tech = await prisma.user.findFirst({
      where: { id: data.assignedTechnicianId, tenantId, isActive: true },
    });
    if (!tech) throw AppError.badRequest('Assigned technician not found in tenant');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      scheduledAt: new Date(data.scheduledAt),
      assignedTechnicianId: data.assignedTechnicianId,
      room: data.room,
      status: 'scheduled',
      // Rescheduling a previously closed/no-show request clears the closure.
      closureReason: null,
      closureNote: null,
      closedBy: null,
      closedAt: null,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  // Notify the assigned technician
  if (data.assignedTechnicianId) {
    await safeNotify({
      tenantId,
      userId: data.assignedTechnicianId,
      title: 'New imaging study assigned',
      message: `Imaging study scheduled at ${new Date(data.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`,
      notificationType: 'general',
      referenceType: 'imaging_request',
      referenceId: id,
    });
  }

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request scheduled');
  return updated;
}

// Radiology admin marks payment as verified. Once flipped, the request
// becomes visible to the radiologist queue (paymentVerified=true) and is
// eligible for scheduleImaging. Idempotent: calling on an already-verified
// request is a no-op (we don't overwrite the verifier/at).
export async function verifyImagingPayment(tenantId: string, id: string, userId: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });
  if (!request) throw AppError.notFound('Imaging request not found');

  if (request.status === 'cancelled') {
    throw AppError.badRequest('Cannot verify payment on a cancelled request');
  }

  if (request.paymentVerified) {
    return request;
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      paymentVerified: true,
      paymentVerifiedBy: userId,
      paymentVerifiedAt: new Date(),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      paymentVerifier: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  // Notify the ordering doctor + any radiologist currently assigned so the
  // study lands on their worklist without a refresh.
  await safeNotify({
    tenantId,
    userId: updated.orderedBy,
    title: 'Imaging payment verified',
    message: `Payment cleared for ${updated.imagingType.toUpperCase()}${updated.bodyPart ? ' — ' + updated.bodyPart : ''}. Patient may proceed to scan.`,
    notificationType: 'general',
    referenceType: 'imaging_request',
    referenceId: id,
  });
  if (updated.assignedTechnicianId) {
    await safeNotify({
      tenantId,
      userId: updated.assignedTechnicianId,
      title: 'New imaging study cleared',
      message: 'Payment verified — study is now in your worklist.',
      notificationType: 'general',
      referenceType: 'imaging_request',
      referenceId: id,
    });
  }

  logger.info({ tenantId, imagingRequestId: id, verifiedBy: userId }, 'Imaging payment verified');
  return updated;
}

// ============================================================
// Imaging Results
// ============================================================

export async function uploadImagingResult(
  tenantId: string,
  userId: string,
  data: UploadImagingResultInput,
) {
  // Verify imaging request exists and belongs to tenant
  const request = await prisma.imagingRequest.findFirst({
    where: { id: data.imagingRequestId, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  // Same payment gate as schedule — radiologist cannot upload results on a
  // request that hasn't been payment-verified by the admin.
  if (!request.paymentVerified) {
    throw AppError.badRequest(
      'Payment for this imaging request has not been verified. Ask the radiology admin to verify payment before uploading results.',
    );
  }

  // Check if a result already exists
  const existingResult = await prisma.imagingResult.findUnique({
    where: { imagingRequestId: data.imagingRequestId },
  });

  if (existingResult) {
    throw AppError.conflict('A result already exists for this imaging request');
  }

  // NOTE: creating the draft result does NOT complete the request. The UI
  // opens this draft the moment the radiologist clicks "Upload Result" so the
  // attachments panel has a resultId to bind to — but if they close without
  // attaching a file, the request must stay in its queue, not flip to
  // completed. The request is marked `completed` only when an actual file is
  // attached (see createImagingAttachment). This enforces the rule
  // "without a file it will not be marked completed".
  const result = await prisma.imagingResult.create({
    data: {
      imagingRequestId: data.imagingRequestId,
      patientId: data.patientId,
      radiologistId: userId,
      impression: data.impression,
      imageUrls: data.imageUrls,
      pacsReferenceId: data.pacsReferenceId,
      status: 'draft',
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true, status: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingResultId: result.id }, 'Imaging draft result created (not completed until a file is attached)');
  return result;
}

export async function getImagingResults(tenantId: string, query: GetImagingResultsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    imagingRequest: { tenantId },
  };

  if ((query as any).pendingApproval) {
    // Admin "Awaiting Approval" queue: exactly what the radiologist has marked
    // done. It used to be "request completed and not published", which swept in
    // drafts the radiologist was still working on.
    where.status = 'finalized';
  } else if ((query as any).draft) {
    // The radiologist's own bench: still being worked on, still editable.
    where.status = 'draft';
  } else if (query.status) {
    where.status = query.status;
  }

  if (query.imagingRequestId) {
    where.imagingRequestId = query.imagingRequestId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { impression: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [results, total] = await Promise.all([
    prisma.imagingResult.findMany({
      where,
      skip,
      take,
      include: {
        imagingRequest: {
          select: { id: true, imagingType: true, bodyPart: true, urgency: true },
        },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        radiologist: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.imagingResult.count({ where }),
  ]);

  return { results, total, page, limit };
}

export async function getImagingResultById(tenantId: string, id: string) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
    include: {
      imagingRequest: {
        select: {
          id: true,
          imagingType: true,
          bodyPart: true,
          urgency: true,
          clinicalIndication: true,
          status: true,
          notes: true,
        },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      radiologist: { select: { id: true, firstName: true, lastName: true, email: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: {
          uploader: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  return result;
}

// Edit a draft / finalized imaging result before sign-off. Lets the
// radiologist correct impression or swap the mirrored PDF URL.
// Published results stay locked — corrections go through verifyImagingResult
// + a fresh draft per audit policy.
export async function editImagingResult(
  tenantId: string,
  id: string,
  data: {
    impression?: string;
    pacsReferenceId?: string;
    pdfReportUrl?: string;
  },
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
  });

  if (!result) throw AppError.notFound('Imaging result not found');
  if (result.status === 'published') {
    throw AppError.badRequest('Cannot edit a published imaging result');
  }

  const updated = await prisma.imagingResult.update({
    where: { id },
    data: {
      impression: data.impression ?? result.impression,
      pacsReferenceId: data.pacsReferenceId ?? result.pacsReferenceId,
      pdfReportUrl: data.pdfReportUrl ?? result.pdfReportUrl,
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingResultId: id }, 'Imaging result edited');
  return updated;
}

export async function addImagingReport(
  tenantId: string,
  id: string,
  userId: string,
  data: AddImagingReportInput,
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  if (result.status === 'published') {
    throw AppError.badRequest('Cannot modify a published imaging result');
  }

  const updated = await prisma.imagingResult.update({
    where: { id },
    data: {
      impression: data.impression,
      pdfReportUrl: data.pdfReportUrl,
      radiologistId: userId,
      status: 'finalized',
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingResultId: id, reportedBy: userId }, 'Imaging report added');
  return updated;
}

/**
 * Mark as Done — the radiologist hands a finished study to the admin.
 *
 * This is the counterpart of the lab technician marking every test done: up to
 * this point the result is a DRAFT they own and can keep editing; afterwards it
 * sits in the admin's approval queue and only the admin's Approve & Publish
 * releases it to the doctor and the patient.
 */
export async function submitImagingResult(
  tenantId: string,
  id: string,
  userId: string,
  impression?: string,
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
    select: { id: true, status: true, imagingRequestId: true, impression: true },
  });
  if (!result) throw AppError.notFound('Imaging result not found');
  if (result.status === 'published') {
    throw AppError.badRequest('This report is already published.');
  }

  // The uploaded files ARE the report — submitting an empty one would put
  // nothing in front of the approver.
  const attachmentCount = await prisma.imagingAttachment.count({
    where: { imagingRequestId: result.imagingRequestId, deletedAt: null },
  });
  if (attachmentCount === 0) {
    throw AppError.badRequest('Upload the study files before marking this done.');
  }

  const [updated] = await prisma.$transaction([
    prisma.imagingResult.update({
      where: { id },
      data: {
        status: 'finalized',
        radiologistId: userId,
        ...(impression !== undefined ? { impression } : {}),
      },
      include: {
        imagingRequest: { select: { id: true, imagingType: true, bodyPart: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        radiologist: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.imagingRequest.update({
      where: { id: result.imagingRequestId },
      data: { status: 'completed', completedAt: new Date() },
    }),
  ]);

  void notifyRadiologyAdmins(
    tenantId,
    'Radiology report awaiting approval',
    `${updated.patient.firstName} ${updated.patient.lastName ?? ''} — ${updated.imagingRequest.imagingType.toUpperCase()}${updated.imagingRequest.bodyPart ? ` ${updated.imagingRequest.bodyPart}` : ''} is ready for review.`.trim(),
    'imaging_result',
    id,
  );

  logger.info({ tenantId, imagingResultId: id, userId }, 'Imaging result submitted for approval');
  return updated;
}

/**
 * Send a submitted report back to the radiologist — the admin's "not yet"
 * answer, so a report that needs another series or a clearer image can be
 * reopened instead of being published or abandoned. Mirrors the lab supervisor
 * re-opening a report for re-submission.
 */
export async function reopenImagingResult(
  tenantId: string,
  id: string,
  userId: string,
  reason?: string,
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
    select: { id: true, status: true, imagingRequestId: true, radiologistId: true },
  });
  if (!result) throw AppError.notFound('Imaging result not found');
  if (result.status === 'published') {
    throw AppError.badRequest('A published report cannot be sent back — publish a correction instead.');
  }
  if (result.status !== 'finalized') {
    throw AppError.badRequest('This report is already a draft with the radiologist.');
  }

  const [updated] = await prisma.$transaction([
    prisma.imagingResult.update({
      where: { id },
      data: { status: 'draft' },
      include: {
        imagingRequest: { select: { id: true, imagingType: true, bodyPart: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      },
    }),
    prisma.imagingRequest.update({
      where: { id: result.imagingRequestId },
      data: { status: 'in_progress', completedAt: null },
    }),
  ]);

  if (result.radiologistId) {
    await safeNotify({
      tenantId,
      userId: result.radiologistId,
      title: 'Radiology report sent back',
      message: reason?.trim()
        ? `Sent back for changes: ${reason.trim()}`
        : 'The radiology admin sent this report back for changes.',
      notificationType: 'general',
      referenceType: 'imaging_result',
      referenceId: id,
    });
  }

  logger.info({ tenantId, imagingResultId: id, userId }, 'Imaging result reopened to draft');
  return updated;
}

export async function verifyImagingResult(tenantId: string, id: string, userId: string) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  if (result.status === 'published') {
    throw AppError.badRequest('Imaging result is already verified and published');
  }

  // Only a report the radiologist has marked done can be approved. A draft is
  // still being worked on — publishing one would release half a study to the
  // doctor and the patient behind the radiologist's back.
  if (result.status !== 'finalized') {
    throw AppError.badRequest(
      'This study is still a draft with the radiologist. It can be approved once they mark it done.',
    );
  }

  // Belt and braces: the uploaded files ARE the report.
  const attachmentCount = await prisma.imagingAttachment.count({
    where: { imagingRequestId: result.imagingRequestId, deletedAt: null },
  });
  if (attachmentCount === 0) {
    throw AppError.badRequest(
      'Cannot publish — no file has been uploaded for this study yet.',
    );
  }

  const updated = await prisma.imagingResult.update({
    where: { id },
    data: {
      status: 'published',
      signedBy: userId,
      signedAt: new Date(),
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true, orderedBy: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const reportRefMsg = `Radiology report (${updated.imagingRequest.imagingType.toUpperCase()}${updated.imagingRequest.bodyPart ? ' - ' + updated.imagingRequest.bodyPart : ''}) is ready.`;

  if (updated.imagingRequest.orderedBy) {
    await safeNotify({
      tenantId,
      userId: updated.imagingRequest.orderedBy,
      title: 'Radiology report ready',
      message: reportRefMsg,
      notificationType: 'lab_result',
      referenceType: 'imaging_result',
      referenceId: id,
    });
  }
  const patient = await prisma.patient.findUnique({ where: { id: result.patientId } });
  const patientUserId = (patient as any)?.userId as string | undefined;
  if (patientUserId) {
    await safeNotify({
      tenantId,
      userId: patientUserId,
      title: 'Your imaging report is ready',
      message: 'Your imaging report has been published. Tap to view.',
      notificationType: 'lab_result',
      referenceType: 'imaging_result',
      referenceId: id,
    });
  }

  logger.info({ tenantId, imagingResultId: id, verifiedBy: userId }, 'Imaging result verified');
  return updated;
}

// ============================================================
// Analytics (TAT, volume by modality, status mix, technician load)
// ============================================================

export async function getImagingAnalytics(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (range.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(range.fromDate) };
  if (range.toDate) where.createdAt = { ...where.createdAt, lte: new Date(range.toDate) };

  const [requests, publishedResults] = await Promise.all([
    prisma.imagingRequest.findMany({
      where,
      select: {
        id: true,
        status: true,
        imagingType: true,
        bodyPart: true,
        urgency: true,
        createdAt: true,
        scheduledAt: true,
        completedAt: true,
        assignedTechnicianId: true,
        assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.imagingResult.findMany({
      where: { imagingRequest: where, status: 'published' },
      select: {
        id: true,
        imagingRequest: { select: { createdAt: true } },
        signedAt: true,
      },
    }),
  ]);

  // Status mix
  const statusMix: Record<string, number> = {
    requested: 0,
    scheduled: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const r of requests) {
    statusMix[r.status] = (statusMix[r.status] ?? 0) + 1;
  }

  // Volume by modality
  const modalityMap = new Map<string, number>();
  for (const r of requests) {
    modalityMap.set(r.imagingType, (modalityMap.get(r.imagingType) ?? 0) + 1);
  }
  const modalityVolume = Array.from(modalityMap.entries())
    .map(([modality, count]) => ({ modality, count }))
    .sort((a, b) => b.count - a.count);

  // Body part top list
  const bodyPartMap = new Map<string, number>();
  for (const r of requests) {
    if (r.bodyPart) bodyPartMap.set(r.bodyPart, (bodyPartMap.get(r.bodyPart) ?? 0) + 1);
  }
  const bodyPartVolume = Array.from(bodyPartMap.entries())
    .map(([bodyPart, count]) => ({ bodyPart, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Urgency mix
  const urgencyMix: Record<string, number> = { routine: 0, urgent: 0, stat: 0 };
  for (const r of requests) {
    urgencyMix[r.urgency] = (urgencyMix[r.urgency] ?? 0) + 1;
  }

  // TAT: request createdAt → result signedAt
  const tats: number[] = [];
  for (const res of publishedResults) {
    if (res.signedAt && res.imagingRequest?.createdAt) {
      tats.push((res.signedAt.getTime() - res.imagingRequest.createdAt.getTime()) / (1000 * 60 * 60));
    }
  }
  const avgTatHours = tats.length ? tats.reduce((a, b) => a + b, 0) / tats.length : 0;
  const medianTatHours = tats.length
    ? [...tats].sort((a, b) => a - b)[Math.floor(tats.length / 2)]
    : 0;

  // Technician workload (assigned requests)
  const techMap = new Map<string, { id: string; name: string; count: number }>();
  for (const r of requests) {
    if (!r.assignedTechnicianId || !r.assignedTechnician) continue;
    const key = r.assignedTechnicianId;
    const existing = techMap.get(key);
    const name = `${r.assignedTechnician.firstName} ${r.assignedTechnician.lastName ?? ''}`.trim();
    if (existing) {
      existing.count += 1;
    } else {
      techMap.set(key, { id: r.assignedTechnicianId, name, count: 1 });
    }
  }
  const technicianWorkload = Array.from(techMap.values()).sort((a, b) => b.count - a.count);

  return {
    summary: {
      totalRequests: requests.length,
      completedRequests: statusMix.completed,
      openRequests:
        statusMix.requested + statusMix.scheduled + statusMix.in_progress,
      publishedReports: publishedResults.length,
      avgTatHours: Number(avgTatHours.toFixed(2)),
      medianTatHours: Number(medianTatHours.toFixed(2)),
    },
    statusMix,
    urgencyMix,
    modalityVolume,
    bodyPartVolume,
    technicianWorkload,
  };
}

// ============================================================
// Dashboard (worklist counts + recent activity)
// ============================================================
// Mirrors the lab dashboard contract — radiology admin lands here and gets a
// real-time snapshot of pending vs scheduled vs in-progress vs awaiting verify
// vs published today, plus the latest few audit-worthy events.

// Radiology billing roll-up — sum of auto-linked imaging BillItems grouped
// by bill status. Drives the radiology_admin Billing page so they don't need
// to leave the module to see "how much have we billed today / what's open".
export async function getImagingBillingSummary(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const where: any = {
    bill: { tenantId },
    referenceType: 'imaging_request',
  };
  if (range.fromDate || range.toDate) {
    where.createdAt = {};
    if (range.fromDate) where.createdAt.gte = new Date(range.fromDate);
    if (range.toDate) where.createdAt.lte = new Date(range.toDate);
  }

  const items = await prisma.billItem.findMany({
    where,
    select: {
      id: true,
      description: true,
      totalAmount: true,
      createdAt: true,
      referenceId: true,
      bill: {
        select: {
          id: true,
          billNumber: true,
          status: true,
          amountPaid: true,
          totalAmount: true,
          balanceDue: true,
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const billStatusBuckets: Record<string, number> = {
    draft: 0,
    pending: 0,
    partially_paid: 0,
    paid: 0,
    overdue: 0,
    cancelled: 0,
  };

  let totalBilled = 0;
  let totalPaid = 0;
  let totalOutstanding = 0;

  for (const it of items) {
    const amount = Number(it.totalAmount ?? 0);
    totalBilled += amount;
    const status = it.bill?.status ?? 'pending';
    billStatusBuckets[status] = (billStatusBuckets[status] ?? 0) + amount;
    if (it.bill) {
      // We can't perfectly split a multi-item bill across line-items, so use a
      // proportional share based on totalAmount of the bill. Good enough for a
      // summary view; the canonical numbers live in /billing.
      const billTotal = Number(it.bill.totalAmount ?? 0);
      if (billTotal > 0) {
        const share = amount / billTotal;
        totalPaid += Number(it.bill.amountPaid ?? 0) * share;
        totalOutstanding += Number(it.bill.balanceDue ?? 0) * share;
      }
    }
  }

  return {
    summary: {
      totalBilled: Number(totalBilled.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      totalOutstanding: Number(totalOutstanding.toFixed(2)),
      itemCount: items.length,
    },
    statusMix: billStatusBuckets,
    recent: items.slice(0, 50),
  };
}

export async function getImagingDashboard(tenantId: string) {
  // Whole IST days — `setHours(0,0,0,0)` is midnight in the SERVER's zone, so
  // every "today" count silently shifted when the box was not on IST.
  const { start: todayStart, end: todayEnd } = istDayRange();
  const tomorrowStart = new Date(todayEnd.getTime() + 1);

  const last24h = new Date();
  last24h.setHours(last24h.getHours() - 24);

  // Counts (all-time, by status)
  const [
    awaitingPaymentVerifyCount,
    pendingCount,
    scheduledCount,
    inProgressCount,
    completedTodayCount,
    statTodayCount,
    awaitingApprovalCount,
    publishedTodayCount,
    cancelledTodayCount,
    totalRequestsToday,
    overdueScheduledCount,
    noShowCount,
    closedTodayCount,
    awaitingAcceptCount,
    draftCount,
    unassignedCount,
    overdueCount,
  ] = await Promise.all([
    // New requests sitting in the radiology_admin queue waiting for payment
    // verification before they reach the radiologist.
    prisma.imagingRequest.count({
      where: { tenantId, paymentVerified: false, status: { notIn: ['cancelled', 'completed'] } },
    }),
    // Requests cleared on payment but not yet scheduled — i.e. radiologist's
    // immediate to-do.
    prisma.imagingRequest.count({
      where: { tenantId, paymentVerified: true, status: 'requested' },
    }),
    prisma.imagingRequest.count({ where: { tenantId, status: 'scheduled' } }),
    prisma.imagingRequest.count({ where: { tenantId, status: 'in_progress' } }),
    prisma.imagingRequest.count({
      where: { tenantId, status: 'completed', completedAt: { gte: todayStart, lt: tomorrowStart } },
    }),
    prisma.imagingRequest.count({
      where: { tenantId, urgency: 'stat', createdAt: { gte: todayStart, lt: tomorrowStart } },
    }),
    // Awaiting admin approval = exactly what a radiologist has marked done.
    // This used to be "request completed and not published", which counted
    // drafts the radiologist was still working on.
    prisma.imagingResult.count({
      where: { imagingRequest: { tenantId }, status: 'finalized' },
    }),
    prisma.imagingResult.count({
      where: {
        imagingRequest: { tenantId },
        status: 'published',
        signedAt: { gte: todayStart, lt: tomorrowStart },
      },
    }),
    prisma.imagingRequest.count({
      where: { tenantId, status: 'cancelled', updatedAt: { gte: todayStart, lt: tomorrowStart } },
    }),
    prisma.imagingRequest.count({
      where: { tenantId, createdAt: { gte: todayStart, lt: tomorrowStart } },
    }),
    // Scheduled requests whose slot has already passed but were never started
    prisma.imagingRequest.count({
      where: {
        tenantId,
        status: 'scheduled',
        scheduledAt: { lt: new Date() },
      },
    }),
    // All-time no-show requests not yet reopened/rescheduled.
    prisma.imagingRequest.count({ where: { tenantId, status: 'no_show' } }),
    // Anything the admin closed today (no-show + reasoned cancellations).
    prisma.imagingRequest.count({
      where: {
        tenantId,
        closedAt: { gte: todayStart, lt: tomorrowStart },
      },
    }),
    // The admin's intake queue: raised by a doctor, not yet accepted.
    prisma.imagingRequest.count({
      where: { tenantId, acceptedAt: null, status: { notIn: ['cancelled', 'no_show', 'completed'] } },
    }),
    // On a radiologist's bench right now — uploaded but not marked done.
    prisma.imagingResult.count({
      where: { imagingRequest: { tenantId }, status: 'draft' },
    }),
    // Accepted but nobody owns it.
    prisma.imagingRequest.count({
      where: {
        tenantId,
        acceptedAt: { not: null },
        assignedTechnicianId: null,
        status: { notIn: ['cancelled', 'no_show', 'completed'] },
      },
    }),
    // Past its 24-hour SLA — the same predicate the overdue filter uses.
    prisma.imagingRequest.count({
      where: IMAGING_OVERDUE_WHERE(tenantId, last24h) as any,
    }),
  ]);

  // Recent activity feed (latest 8 events — newly created requests, scheduled,
  // results awaiting verify, published reports). All from imaging tables; we
  // intentionally don't tap audit_logs here to keep this snappy.
  const [latestRequests, latestResults] = await Promise.all([
    prisma.imagingRequest.findMany({
      where: { tenantId, createdAt: { gte: last24h } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        status: true,
        imagingType: true,
        bodyPart: true,
        urgency: true,
        createdAt: true,
        scheduledAt: true,
        patient: { select: { firstName: true, lastName: true, mrn: true } },
      },
    }),
    prisma.imagingResult.findMany({
      where: { imagingRequest: { tenantId }, updatedAt: { gte: last24h } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        signedAt: true,
        imagingRequest: { select: { imagingType: true, bodyPart: true } },
        patient: { select: { firstName: true, lastName: true, mrn: true } },
      },
    }),
  ]);

  return {
    counts: {
      awaitingPaymentVerify: awaitingPaymentVerifyCount,
      pending: pendingCount,
      scheduled: scheduledCount,
      inProgress: inProgressCount,
      completedToday: completedTodayCount,
      statToday: statTodayCount,
      awaitingApproval: awaitingApprovalCount,
      // Backward-compat alias for older clients that read `awaitingVerify`.
      awaitingVerify: awaitingApprovalCount,
      publishedToday: publishedTodayCount,
      cancelledToday: cancelledTodayCount,
      totalRequestsToday,
      overdueScheduled: overdueScheduledCount,
      noShow: noShowCount,
      closedToday: closedTodayCount,
      // The unified-flow counts, named to match the lab's dashboard so the two
      // summary strips read the same.
      awaitingAccept: awaitingAcceptCount,
      draft: draftCount,
      unassigned: unassignedCount,
      overdue: overdueCount,
    },
    recentRequests: latestRequests,
    recentResults: latestResults,
  };
}
