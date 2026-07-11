import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { sendDischargeSummaryPublishedEmail } from '../../services/email.service';

interface GetMrdQuery {
  page?: number;
  limit?: number;
  direction?: string;
  status?: string;
  search?: string;
}

interface CreateMrdInput {
  patientId: string;
  locationFrom?: string;
  wardRoom?: string;
  doctorId?: string;
  notes?: string;
}

export async function getMrdDocuments(tenantId: string, query: GetMrdQuery) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  const where: any = { tenantId };

  if (query.direction) where.direction = query.direction;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { requestedTo: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [documents, total] = await Promise.all([
    prisma.mrdRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        user: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.mrdRequest.count({ where }),
  ]);

  return { documents, total, page, limit };
}

export async function createMrdRequest(
  tenantId: string,
  userId: string,
  data: CreateMrdInput,
) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const mrdRequest = await prisma.mrdRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      requestedTo: 'MRD Department',
      requestedBy: userId,
      locationFrom: data.locationFrom,
      wardRoom: data.wardRoom,
      status: 'initiated',
      direction: 'outbound',
      notes: data.notes,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
      },
    },
  });

  logger.info({ tenantId, mrdId: mrdRequest.id }, 'MRD request created');
  return mrdRequest;
}

// ==================== Discharge Summary ====================

const dischargeSummaryInclude = {
  admission: {
    select: {
      id: true,
      admissionDate: true,
      dischargeDate: true,
      admissionReason: true,
      status: true,
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  },
  visit: {
    select: { id: true, visitType: true, visitDate: true, chiefComplaint: true },
  },
  patient: {
    select: {
      id: true,
      mrn: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      gender: true,
      phone: true,
      bloodGroup: true,
    },
  },
  doctor: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
      specialization: true,
    },
  },
  signer: {
    select: { id: true, firstName: true, lastName: true },
  },
};

interface GenerateOptions {
  /** If true, regenerates summary fields from source data even if draft already exists. */
  refresh?: boolean;
}

// Join a list of nullable section blocks with a blank line between them;
// returns null when everything is empty.
function mergeSections(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return cleaned.length > 0 ? cleaned.join('\n\n') : null;
}

async function buildSummaryFields(tenantId: string, admissionId: string) {
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    include: {
      visit: true,
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          dateOfBirth: true,
          gender: true,
          phone: true,
          bloodGroup: true,
        },
      },
      doctor: {
        select: {
          id: true,
          user: { select: { firstName: true, lastName: true } },
          specialization: true,
        },
      },
    },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const visitId = admission.visitId;
  const patientId = admission.patientId;

  const [diagnoses, pinnedNotes, sectionPins, labResults, prescriptions] = await Promise.all([
    prisma.diagnosis.findMany({
      where: { visitId },
      orderBy: { diagnosedAt: 'asc' },
    }),
    // Legacy whole-note pins (pinToDischargeSummary=true). Kept for
    // backward compatibility with notes written before the per-section
    // pin model; these feed `proceduresSummary` as before.
    prisma.progressNote.findMany({
      where: {
        visitId,
        pinToDischargeSummary: true,
        status: { in: ['active', 'finalized'] },
      },
      orderBy: { createdAt: 'asc' },
    }),
    // New per-section pins via ProgressNotePin. Each pin carries
    // explicit {dischargeSection, content}; we route the content into
    // the matching DischargeSummary column below.
    prisma.progressNotePin.findMany({
      where: {
        note: {
          visitId,
          status: { in: ['active', 'finalized'] },
        },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        note: {
          select: {
            id: true,
            createdAt: true,
            doctor: {
              select: { user: { select: { firstName: true, lastName: true } } },
            },
          },
        },
      },
    }),
    prisma.labResult.findMany({
      where: { labOrder: { visitId, tenantId } },
      include: {
        labOrderItem: { select: { test: { select: { testName: true } } } },
      },
      orderBy: { enteredAt: 'desc' },
    }),
    prisma.prescription.findMany({
      where: { visitId, tenantId, status: 'active' },
      include: {
        prescriptionItems: {
          select: {
            drugName: true,
            dosage: true,
            frequency: true,
            duration: true,
            route: true,
            instructions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Group section pins by discharge section — O(n) single pass.
  const pinBuckets: Record<string, Array<{ content: string; createdAt: Date; doctor: string }>> =
    {};
  for (const p of sectionPins) {
    const bucket = pinBuckets[p.dischargeSection] ?? (pinBuckets[p.dischargeSection] = []);
    const doctor = p.note?.doctor?.user
      ? `Dr. ${p.note.doctor.user.firstName}${p.note.doctor.user.lastName ? ' ' + p.note.doctor.user.lastName : ''}`
      : 'Attending';
    bucket.push({ content: p.content, createdAt: p.createdAt, doctor });
  }
  const renderBucket = (section: string): string | null => {
    const b = pinBuckets[section];
    if (!b || b.length === 0) return null;
    return b
      .map((x) => {
        const when = x.createdAt.toLocaleDateString('en-IN');
        return `- [${when} · ${x.doctor}] ${x.content}`;
      })
      .join('\n');
  };

  // ── Header ──
  const p = admission.patient;
  const age = p.dateOfBirth
    ? Math.floor((Date.now() - new Date(p.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : null;
  const doctorFullName = admission.doctor?.user
    ? `Dr. ${admission.doctor.user.firstName} ${admission.doctor.user.lastName}`
    : 'Attending Physician';
  const headerLines = [
    `Patient: ${p.firstName} ${p.lastName} (MRN: ${p.mrn})`,
    `${age !== null ? `Age: ${age}` : ''}${p.gender ? ` | Gender: ${p.gender}` : ''}${p.bloodGroup ? ` | Blood Group: ${p.bloodGroup}` : ''}`.trim(),
    p.phone ? `Phone: ${p.phone}` : '',
    `Admitted: ${admission.admissionDate ? new Date(admission.admissionDate).toLocaleDateString('en-IN') : '—'}`,
    `Discharged: ${admission.dischargeDate ? new Date(admission.dischargeDate).toLocaleDateString('en-IN') : '—'}`,
    `Attending: ${doctorFullName}${admission.doctor?.specialization ? ` (${admission.doctor.specialization})` : ''}`,
  ].filter(Boolean);
  const headerSummary = headerLines.join('\n');

  // ── Diagnoses ── (source-derived + pinned section rows)
  const diagnosesBase = diagnoses.length > 0
    ? diagnoses
        .map((d) => `- [${d.diagnosisType}] ${d.diagnosisName}${d.icdCode ? ` (${d.icdCode})` : ''}`)
        .join('\n')
    : null;
  const diagnosisPins = renderBucket('diagnosis');
  const diagnosesSummary = mergeSections([diagnosesBase, diagnosisPins]);

  // ── Hospital course & procedures ──
  // Legacy whole-note pins + new "procedure" and "hospital_course" section
  // pins all roll up into proceduresSummary, with labelled sub-sections so
  // the doctor can tell them apart when reviewing.
  const legacyPinBlock = pinnedNotes.length > 0
    ? pinnedNotes
        .map((n) => {
          const parts: string[] = [];
          const label = n.noteType || 'note';
          parts.push(`- [${label}] ${n.content}`);
          if ((n as any).impressions) parts.push(`  Impression: ${(n as any).impressions}`);
          if ((n as any).discussions) parts.push(`  Discussion: ${(n as any).discussions}`);
          if ((n as any).conclusions) parts.push(`  Conclusion: ${(n as any).conclusions}`);
          const cf = (n as any).customFields as Array<{ label: string; value?: string }> | null;
          if (Array.isArray(cf)) {
            for (const f of cf) {
              if (f?.label && f?.value) parts.push(`  ${f.label}: ${f.value}`);
            }
          }
          return parts.join('\n');
        })
        .join('\n')
    : null;
  const procedurePins = renderBucket('procedure');
  const hospitalCoursePins = renderBucket('hospital_course');
  const hospitalCourseBlock = hospitalCoursePins ? `Hospital course:\n${hospitalCoursePins}` : null;
  const proceduresSummary = mergeSections([legacyPinBlock, procedurePins, hospitalCourseBlock]);

  // ── All lab results (full) ──
  const labResultsSummary = labResults.length > 0
    ? labResults
        .map((r) => {
          const testName = r.labOrderItem?.test?.testName || 'Unknown Test';
          const abnormal = r.isAbnormal ? ' [ABNORMAL]' : '';
          return `- ${testName}: ${r.parameterName} = ${r.value ?? 'N/A'} ${r.unit ?? ''} (Ref: ${r.normalRange ?? 'N/A'})${abnormal}`;
        })
        .join('\n')
    : null;

  // ── Key labs: flagged abnormal only ──
  const abnormal = labResults.filter((r) => r.isAbnormal);
  const keyLabsSummary = abnormal.length > 0
    ? abnormal
        .map((r) => {
          const testName = r.labOrderItem?.test?.testName || 'Unknown Test';
          return `- ${testName}: ${r.parameterName} = ${r.value ?? 'N/A'} ${r.unit ?? ''} (Ref: ${r.normalRange ?? 'N/A'})`;
        })
        .join('\n')
    : null;

  // ── Meds ── (source-derived prescriptions + "medication" section pins)
  const medsBase = prescriptions.length > 0
    ? prescriptions
        .flatMap((p) =>
          p.prescriptionItems.map(
            (item) =>
              `- ${item.drugName} ${item.dosage} | ${item.frequency} | ${item.duration ?? 'ongoing'} | ${item.route}${item.instructions ? ` | ${item.instructions}` : ''}`,
          ),
        )
        .join('\n')
    : null;
  const medicationPins = renderBucket('medication');
  const medicationReconciliation = mergeSections([medsBase, medicationPins]);

  // ── Advice → dischargeInstructions ──
  const dischargeInstructions = renderBucket('advice');

  // ── Follow-up → followUpInstructions ──
  const followUpInstructions = renderBucket('follow_up');

  // ── General section pins → headerSummary suffix ──
  const generalPins = renderBucket('general');
  const headerSummaryWithGeneral = generalPins
    ? `${headerSummary}\n\n${generalPins}`
    : headerSummary;

  return {
    admission,
    visitId,
    patientId,
    headerSummary: headerSummaryWithGeneral,
    diagnosesSummary,
    proceduresSummary,
    labResultsSummary,
    keyLabsSummary,
    medicationReconciliation,
    dischargeInstructions,
    followUpInstructions,
  };
}

export async function generateDischargeSummary(
  tenantId: string,
  admissionId: string,
  options: GenerateOptions = {},
) {
  const existing = await prisma.dischargeSummary.findUnique({
    where: { admissionId },
    include: dischargeSummaryInclude,
  });

  if (existing && !options.refresh) {
    return existing;
  }
  if (existing && options.refresh && existing.status !== 'draft') {
    throw AppError.badRequest('Only draft discharge summaries can be refreshed');
  }

  const built = await buildSummaryFields(tenantId, admissionId);

  if (existing) {
    // Source-derived columns (diagnoses, procedures, meds, labs, header)
    // are always rebuilt on refresh. Manual-edit columns (instructions /
    // follow-up) are preserved unless the user left them empty — that's
    // the "edit in discharge summary shouldn't affect progress notes"
    // contract from the spec.
    const updateData: any = {
      admissionDate: built.admission.admissionDate,
      dischargeDate: built.admission.dischargeDate,
      headerSummary: built.headerSummary,
      diagnosesSummary: built.diagnosesSummary,
      proceduresSummary: built.proceduresSummary,
      labResultsSummary: built.labResultsSummary,
      keyLabsSummary: built.keyLabsSummary,
      medicationReconciliation: built.medicationReconciliation,
    };
    if (!existing.dischargeInstructions || existing.dischargeInstructions.trim() === '') {
      updateData.dischargeInstructions = built.dischargeInstructions;
    }
    if (!existing.followUpInstructions || existing.followUpInstructions.trim() === '') {
      updateData.followUpInstructions = built.followUpInstructions;
    }
    const updated = await prisma.dischargeSummary.update({
      where: { id: existing.id },
      data: updateData,
      include: dischargeSummaryInclude,
    });
    logger.info({ tenantId, dischargeSummaryId: updated.id, admissionId }, 'Discharge summary refreshed');
    return updated;
  }

  // G6 (2.3): an admission's doctor is now nullable (ER pending-placement). A
  // discharge summary requires the treating doctor, so guard the edge case.
  const summaryDoctorId = built.admission.doctorId;
  if (!summaryDoctorId) {
    throw AppError.badRequest('Cannot generate a discharge summary: no treating doctor is assigned to this admission yet.');
  }
  const dischargeSummary = await prisma.dischargeSummary.create({
    data: {
      admissionId,
      visitId: built.visitId,
      patientId: built.patientId,
      doctorId: summaryDoctorId,
      admissionDate: built.admission.admissionDate,
      dischargeDate: built.admission.dischargeDate,
      headerSummary: built.headerSummary,
      diagnosesSummary: built.diagnosesSummary,
      proceduresSummary: built.proceduresSummary,
      labResultsSummary: built.labResultsSummary,
      keyLabsSummary: built.keyLabsSummary,
      medicationReconciliation: built.medicationReconciliation,
      dischargeInstructions: built.dischargeInstructions,
      followUpInstructions: built.followUpInstructions,
      status: 'draft',
    },
    include: dischargeSummaryInclude,
  });

  logger.info(
    { tenantId, dischargeSummaryId: dischargeSummary.id, admissionId },
    'Discharge summary generated',
  );

  return dischargeSummary;
}

export async function refreshDischargeSummary(tenantId: string, id: string) {
  const summary = await getDischargeSummaryById(tenantId, id);
  if (summary.status !== 'draft') {
    throw AppError.badRequest('Only draft discharge summaries can be refreshed');
  }
  return generateDischargeSummary(tenantId, summary.admissionId, { refresh: true });
}

export async function getDischargeSummaryById(tenantId: string, id: string) {
  const summary = await prisma.dischargeSummary.findUnique({
    where: { id },
    include: dischargeSummaryInclude,
  });

  if (!summary) {
    throw AppError.notFound('Discharge summary not found');
  }

  // Verify tenant access via admission
  const admission = await prisma.admission.findFirst({
    where: { id: summary.admissionId, tenantId },
    select: { id: true },
  });

  if (!admission) {
    throw AppError.notFound('Discharge summary not found');
  }

  return summary;
}

export async function getDischargeSummaryByAdmission(tenantId: string, admissionId: string) {
  // Verify admission belongs to tenant
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const summary = await prisma.dischargeSummary.findUnique({
    where: { admissionId },
    include: dischargeSummaryInclude,
  });

  if (!summary) {
    throw AppError.notFound('Discharge summary not found for this admission');
  }

  return summary;
}

interface UpdateDischargeSummaryInput {
  diagnosesSummary?: string;
  proceduresSummary?: string;
  labResultsSummary?: string;
  medicationReconciliation?: string;
  dischargeInstructions?: string;
  followUpDate?: string;
  followUpInstructions?: string;
}

export async function updateDischargeSummary(
  tenantId: string,
  id: string,
  data: UpdateDischargeSummaryInput,
) {
  // Verify the summary exists and belongs to tenant
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'draft') {
    throw AppError.badRequest('Cannot edit a discharge summary that is not in draft status');
  }

  const updateData: any = { ...data };
  if (data.followUpDate) {
    updateData.followUpDate = new Date(data.followUpDate);
  }

  const updated = await prisma.dischargeSummary.update({
    where: { id },
    data: updateData,
    include: dischargeSummaryInclude,
  });

  logger.info({ tenantId, dischargeSummaryId: id }, 'Discharge summary updated');
  return updated;
}

export async function signDischargeSummary(
  tenantId: string,
  id: string,
  userId: string,
  signatureName?: string,
) {
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'draft') {
    throw AppError.badRequest('Only draft discharge summaries can be signed');
  }

  // Capture the typed attestation (e-signature text) alongside signer identity.
  // Stored in eSignatureUrl prefixed with "typed:" so downstream readers can tell
  // it is a typed signature vs a URL to an image.
  const eSignatureUrl = signatureName ? `typed:${signatureName.trim()}` : null;

  const signed = await prisma.dischargeSummary.update({
    where: { id },
    data: {
      status: 'finalized',
      signedBy: userId,
      signedAt: new Date(),
      eSignatureUrl: eSignatureUrl ?? undefined,
    },
    include: dischargeSummaryInclude,
  });

  logger.info(
    { tenantId, dischargeSummaryId: id, signedBy: userId, hasSignatureName: !!signatureName },
    'Discharge summary signed',
  );
  return signed;
}

export async function publishDischargeSummary(tenantId: string, id: string) {
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'finalized') {
    throw AppError.badRequest('Only finalized discharge summaries can be published');
  }

  const published = await prisma.dischargeSummary.update({
    where: { id },
    data: {
      status: 'published',
    },
    include: dischargeSummaryInclude,
  });

  logger.info({ tenantId, dischargeSummaryId: id }, 'Discharge summary published');

  // Side effects: in-app notification + email. Do not fail publish if these fail.
  try {
    await notifyPatientOfDischargeSummary(tenantId, published);
  } catch (err) {
    logger.error(
      { err, tenantId, dischargeSummaryId: id },
      'Failed to send discharge summary notifications (publish still succeeded)',
    );
  }

  return published;
}

/**
 * Fire-and-forget notification pipeline for a newly-published summary:
 *  - Creates an in-app Notification for the patient's linked user (if any).
 *  - Emails the patient (using Patient.email or linked User.email).
 */
async function notifyPatientOfDischargeSummary(
  tenantId: string,
  summary: { id: string; patientId: string; dischargeDate?: Date | null },
) {
  const [patient, tenant] = await Promise.all([
    prisma.patient.findUnique({
      where: { id: summary.patientId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        userId: true,
        user: { select: { id: true, email: true } },
      },
    }),
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    }),
  ]);

  if (!patient) return;

  const patientName = `${patient.firstName} ${patient.lastName ?? ''}`.trim();
  const hospitalName = tenant?.name || 'Hospital';
  const dischargeDate = summary.dischargeDate
    ? new Date(summary.dischargeDate).toLocaleDateString('en-IN')
    : new Date().toLocaleDateString('en-IN');

  // In-app notification — only if the patient has a portal login
  if (patient.userId) {
    try {
      await prisma.notification.create({
        data: {
          tenantId,
          userId: patient.userId,
          title: 'Discharge summary available',
          message: `Your discharge summary from ${hospitalName} is ready to view in your patient portal.`,
          notificationType: 'system',
          channel: 'in_app',
          referenceType: 'discharge_summary',
          referenceId: summary.id,
          sentAt: new Date(),
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to create in-app discharge notification');
    }
  }

  // Email — use Patient.email first, fall back to linked User.email
  const to = patient.email || patient.user?.email;
  if (to) {
    const base = process.env.FRONTEND_URL || process.env.APP_URL || '';
    const portalUrl = base
      ? `${base.replace(/\/$/, '')}/patient-portal/discharge-summaries/${summary.id}`
      : undefined;
    void sendDischargeSummaryPublishedEmail(to, patientName, hospitalName, dischargeDate, portalUrl);
  }
}

/**
 * Get a discharge summary for PDF streaming. Accessible for finalized or published summaries.
 */
export async function getDischargeSummaryForPdf(tenantId: string, id: string) {
  const summary = await getDischargeSummaryById(tenantId, id);
  if (summary.status === 'draft') {
    throw AppError.badRequest('Cannot export a draft discharge summary');
  }
  return summary;
}

/**
 * Patient-portal accessor: only published summaries for patients whose patient records match.
 */
export async function getPublishedDischargeSummariesForPatients(patientIds: string[]) {
  if (patientIds.length === 0) return [];
  return prisma.dischargeSummary.findMany({
    where: {
      patientId: { in: patientIds },
      status: 'published',
    },
    orderBy: { dischargeDate: 'desc' },
    include: {
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, mrn: true, tenant: { select: { id: true, name: true } } } },
    },
  });
}

export async function getPublishedDischargeSummaryForPatient(patientIds: string[], id: string) {
  if (patientIds.length === 0) throw AppError.notFound('Discharge summary not found');
  const summary = await prisma.dischargeSummary.findFirst({
    where: { id, patientId: { in: patientIds }, status: 'published' },
    include: {
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
    },
  });
  if (!summary) throw AppError.notFound('Discharge summary not found');
  return summary;
}
