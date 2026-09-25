import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { formatDateIST } from '../../shared/date.utils';
import { sendDischargeSummaryPublishedEmail } from '../../services/email.service';
import type { DischargeDocument, DischargeVitalRow } from './discharge-summary-pdf';
import { getHospitalBranding } from '../hospital-branding/hospital-branding.service';
import { fullName } from '../../shared/person-name';

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
      visit: {
        include: {
          doctor: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true } },
              specialization: true,
            },
          },
        },
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
    },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const visitId = admission.visitId;
  const patientId = admission.patientId;

  const [diagnoses, allNotes, sectionPins, labResults, prescriptions] = await Promise.all([
    prisma.diagnosis.findMany({
      where: { visitId },
      orderBy: { diagnosedAt: 'asc' },
    }),
    // ALL of the admission's progress notes (the running IP log). Every note now
    // flows into the discharge summary's hospital course automatically — the
    // doctor no longer pins per note. Oldest → newest for a readable course.
    prisma.progressNote.findMany({
      where: {
        visitId,
        status: { in: ['active', 'finalized'] },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        doctor: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
            specialization: true,
          },
        },
      },
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
    // Only results the lab supervisor has RELEASED. A discharge summary is a
    // legal record the patient leaves with — it must not quote a value that is
    // still inside the lab's review loop and could yet be corrected or
    // re-run. Mirrors the gate on the doctor's investigation history and the
    // patient portal.
    prisma.labResult.findMany({
      where: {
        labOrder: {
          visitId,
          tenantId,
          labReport: { status: { in: ['published', 'corrected'] } },
        },
      },
      include: {
        labOrderItem: { select: { test: { select: { testName: true } } } },
      },
      orderBy: { enteredAt: 'desc' },
    }),
    prisma.prescription.findMany({
      where: { visitId, tenantId, status: 'active' },
      include: {
        doctor: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
            specialization: true,
          },
        },
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

  // Emergency admissions may be opened before a consultant is formally put on
  // the Admission/Visit. Once a doctor has actually treated the patient, their
  // authored clinical work is stronger evidence than leaving discharge blocked:
  // use the most recent progress note or prescription author as the treating
  // doctor for this summary. We deliberately do not rewrite the admission's
  // consultant assignment here; generating a document must not perform an
  // administrative handover as a side effect.
  const latestClinicalAuthor = [
    ...allNotes.map((note) => ({
      doctorId: note.doctorId,
      doctor: note.doctor,
      at: note.createdAt,
    })),
    ...prescriptions.map((prescription) => ({
      doctorId: prescription.doctorId,
      doctor: prescription.doctor,
      at: prescription.createdAt,
    })),
  ]
    .filter((entry) => !!entry.doctorId && !!entry.doctor)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const treatingDoctor =
    admission.doctor ?? admission.visit?.doctor ?? latestClinicalAuthor?.doctor ?? null;
  const summaryDoctorId =
    admission.doctorId ?? admission.visit?.doctorId ?? latestClinicalAuthor?.doctorId ?? null;

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
  const doctorFullName = treatingDoctor?.user
    ? `Dr. ${fullName(treatingDoctor.user)}`
    : 'Attending Physician';
  const headerLines = [
    `Patient: ${fullName(p)} (MRN: ${p.mrn})`,
    `${age !== null ? `Age: ${age}` : ''}${p.gender ? ` | Gender: ${p.gender}` : ''}${p.bloodGroup ? ` | Blood Group: ${p.bloodGroup}` : ''}`.trim(),
    p.phone ? `Phone: ${p.phone}` : '',
    `Admitted: ${admission.admissionDate ? new Date(admission.admissionDate).toLocaleDateString('en-IN') : '—'}`,
    `Discharged: ${admission.dischargeDate ? new Date(admission.dischargeDate).toLocaleDateString('en-IN') : '—'}`,
    `Attending: ${doctorFullName}${treatingDoctor?.specialization ? ` (${treatingDoctor.specialization})` : ''}`,
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
  const allNotesBlock = allNotes.length > 0
    ? allNotes
        .map((n) => {
          const when = new Date(n.createdAt).toLocaleDateString('en-IN');
          const dr = (n as any).doctor?.user
            ? `Dr. ${(n as any).doctor.user.firstName}${(n as any).doctor.user.lastName ? ' ' + (n as any).doctor.user.lastName : ''}`
            : 'Doctor';
          const parts: string[] = [`- [${when} · ${dr}] ${n.content}`];
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
  // Explicit "procedure" / "hospital_course" section pins from the consultation
  // page still add to the course (in addition to the auto-included notes above).
  const procedurePins = renderBucket('procedure');
  const hospitalCoursePins = renderBucket('hospital_course');
  const hospitalCourseBlock = hospitalCoursePins ? `Additional hospital-course notes:\n${hospitalCoursePins}` : null;
  const proceduresSummary = mergeSections([allNotesBlock, procedurePins, hospitalCourseBlock]);

  // ── Labs, grouped by the day they were taken ──
  // A stay produces the same panel over and over, so an undated flat list reads
  // as noise — the clinically useful thing is the trend, which needs the dates
  // to be the structure. Newest day first, tests grouped within each day.
  const labLine = (r: (typeof labResults)[number], withFlag: boolean) => {
    const testName = r.labOrderItem?.test?.testName || 'Unknown Test';
    const flag = withFlag && r.isAbnormal ? ' [ABNORMAL]' : '';
    return `- ${testName}: ${r.parameterName} = ${r.value ?? 'N/A'} ${r.unit ?? ''} (Ref: ${r.normalRange ?? 'N/A'})${flag}`;
  };

  const groupByDay = (rows: typeof labResults, withFlag: boolean): string | null => {
    if (rows.length === 0) return null;
    const byDay = new Map<string, string[]>();
    for (const r of rows) {
      // Group on the IST calendar day — a 01:00 draw belongs to that night's
      // date on the ward, not the previous UTC day. dd/MM/yyyy is both the key
      // and the heading the summary prints.
      const day = formatDateIST(r.enteredAt);
      const bucket = byDay.get(day) ?? [];
      bucket.push(labLine(r, withFlag));
      byDay.set(day, bucket);
    }
    // `labResults` arrives newest-first, so insertion order is already the
    // order we want.
    return [...byDay.entries()]
      .map(([day, lines]) => `${day}\n${lines.join('\n')}`)
      .join('\n\n');
  };

  const labResultsSummary = groupByDay(labResults, true);
  const keyLabsSummary = groupByDay(labResults.filter((r) => r.isAbnormal), false);

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
    summaryDoctorId,
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

/**
 * The notes part of `headerSummary`, without the generated demographic block.
 *
 * The column holds an auto-built "Patient: … / Admitted: … / Attending: …"
 * header, and anything extra — general pins, or text the doctor typed — is
 * appended after a blank line. The printed document renders demographics in its
 * own info card, so only the extra part belongs in the body; printing the whole
 * column would repeat the patient's details twice on the page.
 */
function stripGeneratedHeader(headerSummary?: string | null): string | null {
  if (!headerSummary?.trim()) return null;
  const blocks = headerSummary.split(/\n{2,}/);
  // `Patient:` is the first line the generator writes. If the doctor replaced
  // the header wholesale it won't match, and we keep everything rather than
  // silently dropping their text.
  const rest = blocks[0]?.startsWith('Patient:') ? blocks.slice(1) : blocks;
  const text = rest.join('\n\n').trim();
  return text || null;
}

/** Which DischargeSummary column each pin section feeds. */
const PIN_SECTION_TO_COLUMN: Record<string, string> = {
  diagnosis: 'diagnosesSummary',
  procedure: 'proceduresSummary',
  hospital_course: 'proceduresSummary',
  medication: 'medicationReconciliation',
  advice: 'dischargeInstructions',
  follow_up: 'followUpInstructions',
  general: 'headerSummary',
};

/**
 * Fold pins added since the summary was generated into a DRAFT, without
 * touching anything the doctor typed.
 *
 * The full `refresh` path rebuilds the source-derived columns from scratch,
 * which is why the editor never calls it — doing so would discard direct
 * entries. This is the additive half: a pin whose text is not already present
 * gets appended to its column, and nothing is ever removed or rewritten.
 */
async function mergeNewPinsIntoDraft(
  tenantId: string,
  admissionId: string,
  existing: { id: string } & Record<string, any>,
) {
  const pins = await prisma.progressNotePin.findMany({
    where: { note: { admissionId, status: { in: ['active', 'finalized'] } } },
    orderBy: { createdAt: 'asc' },
    include: {
      note: { select: { createdAt: true, doctor: { select: { user: { select: { firstName: true, lastName: true } } } } } },
    },
  });
  if (pins.length === 0) return existing;

  const additions: Record<string, string[]> = {};
  for (const p of pins) {
    const column = PIN_SECTION_TO_COLUMN[p.dischargeSection];
    if (!column) continue;
    const current: string = existing[column] ?? '';
    // Match on the pin's own words rather than the rendered line: the doctor
    // may have reworded the surrounding text, and re-adding the same content
    // under a slightly different prefix would duplicate it on every open.
    if (current.includes(p.content.trim())) continue;

    const doctor = p.note?.doctor?.user
      ? `Dr. ${p.note.doctor.user.firstName}${p.note.doctor.user.lastName ? ' ' + p.note.doctor.user.lastName : ''}`
      : 'Attending';
    const when = formatDateIST(p.createdAt);
    const line = `- [${when} · ${doctor}] ${p.content}`;
    (additions[column] ??= []).push(line);
  }

  const entries = Object.entries(additions);
  if (entries.length === 0) return existing;

  const data: Record<string, string> = {};
  for (const [column, lines] of entries) {
    const current: string = existing[column] ?? '';
    data[column] = current.trim() ? `${current.trim()}\n${lines.join('\n')}` : lines.join('\n');
  }

  logger.info(
    { tenantId, admissionId, columns: Object.keys(data) },
    'Folded new discharge-summary pins into the draft',
  );
  return prisma.dischargeSummary.update({
    where: { id: existing.id },
    data,
    include: dischargeSummaryInclude,
  });
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
    // A pin added AFTER the summary was first generated used to be invisible
    // forever: the summary is built once, the editor never asks for a refresh,
    // and refresh is a full rebuild that would wipe whatever the doctor had
    // typed. So while the summary is still a draft, fold in only pins that are
    // not already in the text — additive, so direct entries survive.
    if (existing.status === 'draft') {
      return mergeNewPinsIntoDraft(tenantId, admissionId, existing);
    }
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

  // An admission's doctor is nullable during ER pending-placement. Prefer the
  // resolved clinical author above, but keep a clear guard for truly untreated
  // admissions.
  const summaryDoctorId = built.summaryDoctorId;
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
  /** "After 3 months" — an interval with no fixed day. */
  followUpAfterValue?: number | null;
  followUpAfterUnit?: string | null;
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

export async function publishDischargeSummary(tenantId: string, id: string, userId: string) {
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

  // Publishing is the doctor's CLINICAL sign-off — it no longer discharges the
  // patient. Marking someone discharged here dropped them off every active-IP
  // worklist (which filter status='admitted') while money was still outstanding,
  // so the balance was effectively written off. The patient now stays admitted,
  // holding their bed, until Front Desk / Billing clears the final bill and
  // calls PATCH /clinical/admissions/:id/discharge.
  let discharged = false;
  let dischargeReady = false;
  try {
    const admission = await prisma.admission.findFirst({
      where: { id: published.admissionId, tenantId },
      select: { status: true },
    });
    discharged = admission?.status === 'discharged';
    if (admission && !discharged) {
      // Move the stay into `ready_to_discharge`. This is still an ACTIVE
      // admission (see shared/admission-status.ts) — the bed stays occupied and
      // charges keep accruing — it just stops reading as an ordinary
      // in-patient on the ward and billing screens.
      if (admission.status === 'admitted') {
        await prisma.admission.update({
          where: { id: published.admissionId },
          data: { status: 'ready_to_discharge' },
        });
      }
      dischargeReady = true;
      await notifyCounterOfDischargeReady(tenantId, published);
    }
  } catch (err) {
    logger.error(
      { err, tenantId, admissionId: published.admissionId },
      'Discharge-ready notification failed (publish still succeeded)',
    );
  }

  return Object.assign(published, { discharged, dischargeReady });
}

/**
 * Tell the cash counter a patient is clinically cleared and now waiting on bill
 * clearance. Without this the published summary is invisible to Front Desk and
 * the patient sits in a bed nobody is tracking.
 */
async function notifyCounterOfDischargeReady(
  tenantId: string,
  summary: { id: string; admissionId: string; patientId: string },
) {
  const [patient, staff] = await Promise.all([
    prisma.patient.findUnique({
      where: { id: summary.patientId },
      select: { firstName: true, lastName: true, mrn: true },
    }),
    prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: { some: { role: { name: { in: ['front_desk', 'billing_admin', 'cashier'] } } } },
      },
      select: { id: true },
    }),
  ]);
  if (staff.length === 0) return;

  const name = patient ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() : 'A patient';
  await prisma.notification.createMany({
    data: staff.map((s) => ({
      tenantId,
      userId: s.id,
      title: 'Patient ready for discharge',
      message: `${name} (${patient?.mrn ?? '—'}) has a signed discharge summary. Clear the final bill to complete the discharge.`,
      notificationType: 'system' as const,
      channel: 'in_app' as const,
      // Specific type, not a bare 'admission': the bell deep-links on it, and
      // it has to mean "go finalise this stay's bill" and nothing else.
      referenceType: 'discharge_ready',
      referenceId: summary.admissionId,
      sentAt: new Date(),
    })),
  });
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
 * Assemble the FULL, fully-detailed discharge document for an admission — the
 * doctor's signed narrative sections PLUS all the structured clinical data
 * (demographics, admission/LOS, emergency contact, allergies, vitals on
 * admission & discharge, procedures, imaging, structured discharge meds). Used
 * for both the PDF and the on-screen print view so they render identically.
 */
export async function buildDischargeDocument(tenantId: string, id: string): Promise<DischargeDocument> {
  const summary = await getDischargeSummaryById(tenantId, id);
  const { visitId, patientId } = summary;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  const [patient, branding, emergency, allergies, diagnoses, vitalsAll, otRequests, imaging, prescriptions] = await Promise.all([
    prisma.patient.findFirst({
      where: { id: patientId },
      select: {
        firstName: true, lastName: true, mrn: true, dateOfBirth: true, gender: true,
        bloodGroup: true, phone: true, addressLine1: true, addressLine2: true, city: true,
        state: true, maritalStatus: true, nationality: true,
      },
    }),
    // The hospital's configured PDF/print branding (letterhead, logo, colours).
    getHospitalBranding(tenantId),
    prisma.patientEmergencyContact.findFirst({
      where: { patientId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { name: true, relationship: true, phone: true },
    }),
    prisma.patientAllergy.findMany({ where: { patientId }, select: { allergen: true, reaction: true }, orderBy: { createdAt: 'asc' } }),
    prisma.diagnosis.findMany({ where: { visitId }, orderBy: { diagnosedAt: 'asc' }, select: { diagnosisName: true, diagnosisType: true, icdCode: true } }),
    prisma.vital.findMany({ where: { visitId }, orderBy: { recordedAt: 'asc' } }),
    prisma.otRequest.findMany({
      where: { visitId, tenantId },
      orderBy: [{ scheduledDate: 'asc' }],
      select: { procedureName: true, surgeryType: true, scheduledDate: true, actualStartTime: true, status: true, surgeon: { select: { user: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.imagingRequest.findMany({
      where: { visitId, tenantId },
      orderBy: { createdAt: 'asc' },
      select: { bodyPart: true, clinicalIndication: true, completedAt: true, imagingResult: { select: { impression: true } } },
    }),
    prisma.prescription.findMany({
      where: { visitId, tenantId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      include: { prescriptionItems: { select: { drugName: true, dosage: true, frequency: true, duration: true, route: true, instructions: true } } },
    }),
  ]);

  // Canonical vitals: drop rows that have been superseded by a correction.
  const superseded = new Set(vitalsAll.map((v) => v.supersedesVitalId).filter((x): x is string => !!x));
  const vitals = vitalsAll.filter((v) => !superseded.has(v.id));
  const toVitalRow = (v?: (typeof vitals)[number]): DischargeVitalRow | null =>
    v
      ? {
          at: v.recordedAt.toISOString(),
          bp: v.bloodPressureSystolic != null && v.bloodPressureDiastolic != null ? `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}` : null,
          pulse: v.pulseRate ?? null,
          temp: num(v.temperature),
          rr: v.respiratoryRate ?? null,
          spo2: num(v.oxygenSaturation),
          weight: num(v.weightKg),
          height: num(v.heightCm),
          bmi: num(v.bmi),
          sugar: num(v.bloodSugar),
        }
      : null;

  const admissionDate = summary.admission?.admissionDate ?? null;
  const dischargeDate = summary.admission?.dischargeDate ?? null;
  const los = admissionDate && dischargeDate
    ? Math.max(1, Math.round((new Date(dischargeDate).getTime() - new Date(admissionDate).getTime()) / 86_400_000))
    : null;
  const age = patient?.dateOfBirth ? Math.floor((Date.now() - new Date(patient.dateOfBirth).getTime()) / (365.25 * 86_400_000)) : null;
  const attending = summary.doctor?.user ? `Dr. ${summary.doctor.user.firstName} ${summary.doctor.user.lastName ?? ''}`.trim() : 'Attending Physician';

  return {
    hospital: branding,
    meta: {
      id: summary.id,
      status: summary.status,
      signedAt: summary.signedAt ? summary.signedAt.toISOString() : null,
      signerName: summary.signer ? `${summary.signer.firstName} ${summary.signer.lastName ?? ''}`.trim() : null,
      attestation: summary.eSignatureUrl?.startsWith('typed:') ? summary.eSignatureUrl.replace(/^typed:/, '') : null,
      generatedAt: new Date().toISOString(),
    },
    patient: {
      name: patient ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() : 'Unknown',
      mrn: patient?.mrn ?? null,
      age,
      gender: patient?.gender ?? null,
      dob: patient?.dateOfBirth ? patient.dateOfBirth.toISOString() : null,
      bloodGroup: patient?.bloodGroup ?? null,
      phone: patient?.phone ?? null,
      address: [patient?.addressLine1, patient?.addressLine2, patient?.city, patient?.state].filter(Boolean).join(', ') || null,
      maritalStatus: patient?.maritalStatus ?? null,
      nationality: patient?.nationality ?? null,
    },
    emergencyContact: emergency ? { name: emergency.name, relationship: emergency.relationship, phone: emergency.phone } : null,
    admission: {
      admissionDate: admissionDate ? admissionDate.toISOString() : null,
      dischargeDate: dischargeDate ? dischargeDate.toISOString() : null,
      lengthOfStayDays: los,
      ward: summary.admission?.ward?.name ?? null,
      bed: summary.admission?.bed?.bedNumber ?? null,
      reason: summary.admission?.admissionReason ?? null,
      chiefComplaint: summary.visit?.chiefComplaint ?? null,
      attendingDoctor: attending,
      specialization: summary.doctor?.specialization ?? null,
    },
    allergies: allergies.map((a) => ({ allergen: a.allergen, reaction: a.reaction ?? null })),
    diagnoses: diagnoses.map((d) => ({ name: d.diagnosisName, type: String(d.diagnosisType), icdCode: d.icdCode ?? null })),
    vitals: { admission: toVitalRow(vitals[0]), discharge: toVitalRow(vitals[vitals.length - 1]) },
    procedures: otRequests.map((o) => ({
      name: o.procedureName,
      type: o.surgeryType ?? null,
      date: (o.actualStartTime ?? o.scheduledDate)?.toISOString() ?? null,
      status: String(o.status),
      surgeon: o.surgeon?.user ? `Dr. ${o.surgeon.user.firstName} ${o.surgeon.user.lastName ?? ''}`.trim() : null,
    })),
    imaging: imaging
      .filter((im) => im.imagingResult?.impression || im.completedAt)
      .map((im) => ({ study: im.bodyPart ?? 'Imaging', indication: im.clinicalIndication ?? null, impression: im.imagingResult?.impression ?? null, date: im.completedAt ? im.completedAt.toISOString() : null })),
    sections: {
      // The header column carries the "general" pin bucket and anything the
      // doctor typed there. It was left out of this payload entirely, so none
      // of it could ever print.
      headerNotes: stripGeneratedHeader(summary.headerSummary),
      diagnosesText: summary.diagnosesSummary ?? null,
      hospitalCourse: summary.proceduresSummary ?? null,
      keyLabs: summary.keyLabsSummary ?? null,
      labResults: summary.labResultsSummary ?? null,
      medicationsText: summary.medicationReconciliation ?? null,
      dischargeInstructions: summary.dischargeInstructions ?? null,
      followUpDate: summary.followUpDate ? summary.followUpDate.toISOString() : null,
      // Rendered in place of a date when the doctor meant an interval.
      followUpAfterValue: summary.followUpAfterValue ?? null,
      followUpAfterUnit: summary.followUpAfterUnit ?? null,
      followUpInstructions: summary.followUpInstructions ?? null,
    },
    medications: prescriptions.flatMap((p) =>
      p.prescriptionItems.map((it) => ({
        drug: it.drugName,
        dosage: it.dosage,
        frequency: it.frequency,
        duration: it.duration ?? null,
        route: String(it.route),
        instructions: it.instructions ?? null,
      })),
    ),
  };
}

/** Document for PDF/print export — blocks drafts (same rule as the PDF). */
export async function getDischargeDocumentForExport(tenantId: string, id: string) {
  const summary = await getDischargeSummaryById(tenantId, id);
  if (summary.status === 'draft') {
    throw AppError.badRequest('Cannot export a draft discharge summary — sign it first.');
  }
  return buildDischargeDocument(tenantId, id);
}

/**
 * Patient-portal accessor: only published summaries for patients whose patient records match.
 */
/**
 * A patient's past discharge summaries, for the clinician-facing history panel.
 *
 * The panel a doctor actually opens during a consultation asked only the four
 * `/medical-history/*` endpoints, so a previous admission's summary — often the
 * single most useful document about this patient — was not reachable from it.
 * The full patient file does carry them, but that is a different, much heavier
 * screen.
 *
 * Deliberately a light list: enough to choose one, not the document itself.
 * The existing `/discharge-summary/:id/document` renders the chosen one.
 *
 * Drafts are included, unlike the patient-portal reader — a doctor reviewing a
 * stay in progress needs to see the summary being written, and the status is on
 * the row so an unfinished one reads as unfinished.
 */
export async function getDischargeSummariesForPatient(tenantId: string, patientId: string) {
  const rows = await prisma.dischargeSummary.findMany({
    // DischargeSummary has no tenant column — it hangs off the admission, so
    // the tenant scope comes through that.
    where: { patientId, admission: { tenantId } },
    orderBy: [{ dischargeDate: 'desc' }, { createdAt: 'desc' }],
    take: 30,
    select: {
      id: true,
      status: true,
      dischargeDate: true,
      admissionDate: true,
      // The one-line clinical answer to "what was this stay about" — enough to
      // pick the right summary without opening each one.
      diagnosesSummary: true,
      createdAt: true,
      admissionId: true,
      // The admission's own dates are the fallback below — the summary is
      // written BEFORE the patient goes home, so its copy is often null.
      admission: {
        select: { id: true, admissionType: true, admissionDate: true, dischargeDate: true },
      },
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    admissionId: r.admissionId,
    admissionType: r.admission?.admissionType ?? null,
    admissionDate: r.admissionDate ?? r.admission?.admissionDate ?? null,
    // The summary snapshots the admission's discharge date when it is written
    // — but the summary IS the discharge gate, so it is written while the
    // patient is still admitted and that date does not exist yet. Nothing
    // backfilled it afterwards, so every stored copy was null: on the dev
    // database 9 out of 9, while the admission itself had a real date on 7.
    // The history panel renders that field as each row's headline, so every
    // past discharge summary read "Not yet discharged" — which is exactly how
    // "past discharge summaries are not available" looks to a doctor scanning
    // the list. Falling back to the admission fixes the rows already on file
    // without a migration, and stops a future gap reproducing it.
    dischargeDate: r.dischargeDate ?? r.admission?.dischargeDate ?? null,
    diagnosesSummary: r.diagnosesSummary,
    doctorName: r.doctor?.user
      ? `${r.doctor.user.firstName} ${r.doctor.user.lastName ?? ''}`.trim()
      : null,
    createdAt: r.createdAt,
  }));
}

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
