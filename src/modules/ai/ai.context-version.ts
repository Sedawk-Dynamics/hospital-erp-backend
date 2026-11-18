import { resolvePersonPatientIds } from '../../shared/patient-identity';
import { prisma } from '../../config/database';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { buildPatientContext, BuiltPatientContext } from './ai.context';
import { buildGuidelineContext } from './cdss.multimodal';
import { GuidelineSource } from './cdss.multimodal';

const CONTEXT_TTL_SECONDS = 60 * 60;

export async function getClinicalVersion(
  tenantId: string,
  patientId: string,
): Promise<string> {
  const personIds = await resolvePersonPatientIds(patientId);

  const [
    allergy,
    visit,
    diagnosis,
    prescription,
    labResult,
    labReport,
    labAttachment,
    imagingRequest,
    imagingResult,
    dicomStudy,
    personalHistory,
    familyHistory,
    vital,
  ] = await Promise.all([
    prisma.patientAllergy.aggregate({
      where: { patientId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.visit.aggregate({
      where: { patientId, tenantId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.diagnosis.aggregate({
      where: { patientId, visit: { tenantId } },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.prescription.aggregate({
      where: { patientId, tenantId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.labResult.aggregate({
      where: {
        patientId,
        labOrder: { tenantId, labReport: { status: { in: ['published', 'corrected'] } } },
      },
      _max: { enteredAt: true, verifiedAt: true },
      _count: true,
    }),
    prisma.labReport.aggregate({
      where: { patientId, labOrder: { tenantId } },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.labAttachment.aggregate({
      where: { labOrder: { tenantId, patientId } },
      _max: { createdAt: true, deletedAt: true },
      _count: true,
    }),
    prisma.imagingRequest.aggregate({
      where: { patientId, tenantId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.imagingResult.aggregate({
      where: { patientId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.dicomStudy.aggregate({
      where: { patientId, tenantId },
      _max: { createdAt: true },
      _count: true,
    }),
    prisma.patientPersonalHistory.aggregate({
      where: { patientId: { in: personIds } },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.patientFamilyHistory.aggregate({
      where: { patientId },
      _max: { updatedAt: true },
      _count: true,
    }),
    prisma.vital.aggregate({
      where: { patientId, visit: { tenantId } },
      _max: { recordedAt: true },
      _count: true,
    }),
  ]);

  const times: Array<Date | null> = [
    allergy._max.updatedAt,
    visit._max.updatedAt,
    diagnosis._max.updatedAt,
    prescription._max.updatedAt,
    labResult._max.enteredAt,
    labResult._max.verifiedAt,
    labReport._max.updatedAt,
    labAttachment._max.createdAt,
    labAttachment._max.deletedAt,
    imagingRequest._max.updatedAt,
    imagingResult._max.updatedAt,
    dicomStudy._max.createdAt,
    personalHistory._max.updatedAt,
    familyHistory._max.updatedAt,
    vital._max.recordedAt,
  ];
  const maxTs = times.reduce<Date | null>(
    (acc, t) => (t && (!acc || t > acc) ? t : acc),
    null,
  );

  // Total rows across every source (catches deletes and same-timestamp edits).
  const total =
    allergy._count +
    visit._count +
    diagnosis._count +
    prescription._count +
    labResult._count +
    labReport._count +
    labAttachment._count +
    imagingRequest._count +
    imagingResult._count +
    dicomStudy._count +
    personalHistory._count +
    familyHistory._count +
    vital._count;

  const version = `${maxTs ? maxTs.toISOString() : '0'}:${total}`;

  return version;
}

export async function getOrBuildContext(
  tenantId: string,
  patientId: string,
): Promise<{ context: BuiltPatientContext; version: string }> {
  const key = `ai:ctx:${tenantId}:${patientId}`;
  const version = await getClinicalVersion(tenantId, patientId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as { version: string; context: BuiltPatientContext };
      if (parsed.version === version) return { context: parsed.context, version };
    }
  } catch (err) {
    logger.warn({ err, patientId }, 'AI context cache read failed');
  }

  const context = await buildPatientContext(tenantId, patientId);

  try {
    await redis.set(key, JSON.stringify({ version, context }), 'EX', CONTEXT_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, patientId }, 'AI context cache write failed');
  }

  return { context, version };
}


type GuidelineContext = { guidelines: string; sources: GuidelineSource[] } | null;


export async function getOrBuildGuidelineContext(
  tenantId: string,
  patientId: string,
  patientContext:string,
  cacheVersion:string,
): Promise<GuidelineContext> {
  const key = `ai:guideline:${tenantId}:${patientId}:${patientId}:${cacheVersion}`;

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as GuidelineContext;
    }
  } catch (err) {
    logger.warn({ err, patientId }, 'AI guideline cache read failed');
  }

  const guideline = await buildGuidelineContext(patientContext);

  try {
    await redis.set(key, JSON.stringify(guideline), 'EX', CONTEXT_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, patientId }, 'AI guideline cache write failed');
  }

  return guideline;
}

