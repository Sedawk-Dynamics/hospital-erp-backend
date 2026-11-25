import { prisma } from "../../config/database"
import { AppError } from '../../shared/appError';

function timeToDate(hhmm?: string): Date {
    if (!hhmm) return new Date();
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h)) return new Date();
    const d = new Date();
    d.setHours(h, m || 0, 0, 0);
    return d;
}

const VENT_MODE_MAP: Record<string, 'prvc' | 'vcv' | 'pcv' | 'psv' | 'niv_bipap' | 'hfnc'> = {
    PRVC: 'prvc',
    VCV: 'vcv',
    PCV: 'pcv',
    PSV: 'psv',
    'NIV-BiPAP': 'niv_bipap',
    HFNC: 'hfnc',
};

export const balanceFluids = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    return prisma.icuFluidBalance.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            recordedAt: timeToDate(data.hour),
            ivCrystMl: data.ivCrystMl,
            bloodProdMl: data.bloodProdMl,
            carrierMedMl: data.carrierMedMl,
            enteralMl: data.enteralMl,
            foleyUrineMl: data.foleyUrineMl,
            drainsIcdMl: data.drainsIcdMl,
            urineCharacter: data.urineCharacter,
        },
    });
};

export const ventAbg = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    return prisma.icuAbgVent.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            recordedAt: new Date(),
            ph: data.ph,
            paO2Mmhg: data.paO2Mmhg,
            paCo2Mmhg: data.paCo2Mmhg,
            hco3Meql: data.hco3Meql,
            baseExcessMeql: data.baseExcessMeql,
            lactateMmoll: data.lactateMmoll,
            fio2Pct: data.fio2Pct,
            sodiumMeql: data.sodiumMeql,
            chlorideMeql: data.chlorideMeql,
            mode: data.mode ? VENT_MODE_MAP[data.mode] : undefined,
            tidalVolumeMl: data.tidalVolumeMl,
            peepCmh2o: data.peepCmh2o,
            pipCmh2o: data.pipCmh2o,
            pplatCmh2o: data.pplatCmh2o,
            breathingRatePerMin: data.breathingRatePerMin,
            ettCuffCmh2o: data.ettCuffCmh2o,
        },
    });
}

export const HugFast = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    const toBool = (v?: 'yes' | 'no') => (v == null ? undefined : v === 'yes');

    return prisma.icuFastHugSepsis.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            recordedAt: new Date(),
            feeding: data.feeding,
            analgesia: data.analgesia,
            sedation: data.sedation,
            thromboprophylaxis: data.thromboprophylaxis,
            headOfBed: data.headOfBed,
            ulcerProphylaxis: data.ulcerProphylaxis,
            glucoseControl: data.glucoseControl,
            bowelCare: data.bowelCare,
            bloodCulturesDone: toBool(data.bloodCulturesDone),
            bloodCulturesTime: data.bloodCulturesTime ? timeToDate(data.bloodCulturesTime) : undefined,
            antibioticsGiven: toBool(data.antibioticsGiven),
            antibioticName: data.antibioticName,
            lactateDone: toBool(data.lactateDone),
            lactateMmoll: data.lactateMmoll,
            fluidBolusGiven: toBool(data.fluidBolusGiven),
            bolusVolumeMl: data.bolusVolumeMl,
            vasopressorsStarted: toBool(data.vasopressorsStarted),
            mapTargetReached: toBool(data.mapTargetReached),
        },
    });
}

export const lineInvasive = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    const toDate = (v?: string) => (v ? new Date(v) : undefined);

    return prisma.icuInvasiveLine.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            deviceType: data.deviceType,
            status: data.status ?? 'active',
            bodySite: data.bodySite,
            details: data.details,
            insertedAt: toDate(data.insertedAt),
            insertedBy: data.insertedBy,
            dressingDue: toDate(data.dressingDue),
        },
    });
}

export const pumpInfusion = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    return prisma.icuInfusionPump.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            noradSyringeMg: data.noradSyringeMg,
            noradDoseMcgKgMin: data.noradDoseMcgKgMin,
            weightKg: data.weight,
        },
    });
}

export const scoreSeverity = async (admissionId: string, tenantId: string, data: any) => {
    const admission = await prisma.admission.findFirst({
        where: { id: admissionId, tenantId },
        select: { id: true, patientId: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');

    return prisma.icuSeverityScore.create({
        data: {
            tenantId,
            admissionId: admission.id,
            patientId: admission.patientId,
            recordedAt: new Date(),
            sofaRespiration: data.sofaRespiration,
            sofaCoagulation: data.sofaCoagulation,
            sofaLiver: data.sofaLiver,
            sofaCardiovascular: data.sofaCardiovascular,
            sofaCns: data.sofaCns,
            sofaRenal: data.sofaRenal,
            sofaTotal: data.sofaTotal,
            apacheScore: data.apacheScore,
        },
    });
}

const listWhere = (admissionId: string, tenantId: string) => ({ admissionId, tenantId });
const listOrder = { recordedAt: 'desc' as const };

export const listFluidBalance = (admissionId: string, tenantId: string) =>
    prisma.icuFluidBalance.findMany({ where: listWhere(admissionId, tenantId), orderBy: listOrder });

export const listAbgVent = (admissionId: string, tenantId: string) =>
    prisma.icuAbgVent.findMany({ where: listWhere(admissionId, tenantId), orderBy: listOrder });

export const listFastHug = (admissionId: string, tenantId: string) =>
    prisma.icuFastHugSepsis.findMany({ where: listWhere(admissionId, tenantId), orderBy: listOrder });

export const listSeverityScore = (admissionId: string, tenantId: string) =>
    prisma.icuSeverityScore.findMany({ where: listWhere(admissionId, tenantId), orderBy: listOrder });

// These two have no recordedAt column — order by createdAt instead.
export const listInvasiveLine = (admissionId: string, tenantId: string) =>
    prisma.icuInvasiveLine.findMany({ where: listWhere(admissionId, tenantId), orderBy: { createdAt: 'desc' } });

export const listInfusionPump = (admissionId: string, tenantId: string) =>
    prisma.icuInfusionPump.findMany({ where: listWhere(admissionId, tenantId), orderBy: { createdAt: 'desc' } });