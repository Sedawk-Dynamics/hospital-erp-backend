import { z } from 'zod';

// admissionId is a route param on every ICU endpoint.
const admissionParams = z.object({
  admissionId: z.string().uuid('Invalid admission ID'),
});

const optionalNumber = z.number().optional();
const yesNo = z.enum(['yes', 'no']).optional();

// 1. Fluid Balance -----------------------------------------------------------
export const fluidBalanceSchema = z.object({
  params: admissionParams,
  body: z.object({
    hour: z.string().min(1, 'Hour is required'),
    ivCrystMl: optionalNumber,
    bloodProdMl: optionalNumber,
    carrierMedMl: optionalNumber,
    enteralMl: optionalNumber,
    foleyUrineMl: optionalNumber,
    drainsIcdMl: optionalNumber,
    urineCharacter: z.enum(['clear_amber', 'hazy_cloudy', 'hematuria', 'concentrated_dark']).optional(),
    weight: optionalNumber,
  }),
});

// 2. ABG + Ventilator --------------------------------------------------------
export const abgVentSchema = z.object({
  params: admissionParams,
  body: z.object({
    ph: optionalNumber,
    paO2Mmhg: optionalNumber,
    paCo2Mmhg: optionalNumber,
    hco3Meql: optionalNumber,
    baseExcessMeql: optionalNumber,
    lactateMmoll: optionalNumber,
    fio2Pct: optionalNumber,
    sodiumMeql: optionalNumber,
    chlorideMeql: optionalNumber,
    mode: z.enum(['PRVC', 'VCV', 'PCV', 'PSV', 'NIV-BiPAP', 'HFNC']).optional(),
    tidalVolumeMl: optionalNumber,
    peepCmh2o: optionalNumber,
    pipCmh2o: optionalNumber,
    pplatCmh2o: optionalNumber,
    breathingRatePerMin: optionalNumber,
    ettCuffCmh2o: optionalNumber,
    weight: optionalNumber,
  }),
});

// 3. FAST-HUG + Sepsis -------------------------------------------------------
export const fastHugSepsisSchema = z.object({
  params: admissionParams,
  body: z.object({
    feeding: z.string().optional(),
    analgesia: z.string().optional(),
    sedation: z.string().optional(),
    thromboprophylaxis: z.string().optional(),
    headOfBed: z.string().optional(),
    ulcerProphylaxis: z.string().optional(),
    glucoseControl: z.string().optional(),
    bowelCare: z.string().optional(),
    bloodCulturesDone: yesNo,
    bloodCulturesTime: z.string().optional(),
    antibioticsGiven: yesNo,
    antibioticName: z.string().optional(),
    lactateDone: yesNo,
    lactateMmoll: optionalNumber,
    fluidBolusGiven: yesNo,
    bolusVolumeMl: optionalNumber,
    vasopressorsStarted: yesNo,
    mapTargetReached: yesNo,
    weight: optionalNumber,
  }),
});

// 4. Invasive Lines ----------------------------------------------------------
export const invasiveLineSchema = z.object({
  params: admissionParams,
  body: z.object({
    deviceType: z.string().min(1, 'Device type is required'),
    status: z.enum(['active', 'removed']).optional(),
    bodySite: z.string().optional(),
    details: z.string().optional(),
    insertedAt: z.string().optional(),
    insertedBy: z.string().optional(),
    dressingDue: z.string().optional(),
    weight: optionalNumber,
  }),
});

// 5. Infusion Pumps ----------------------------------------------------------
export const infusionPumpSchema = z.object({
  params: admissionParams,
  body: z.object({
    noradSyringeMg: optionalNumber,
    noradDoseMcgKgMin: optionalNumber,
    weight: optionalNumber,
  }),
});

// 6. Severity Scores ---------------------------------------------------------
export const severityScoreSchema = z.object({
  params: admissionParams,
  body: z.object({
    sofaRespiration: optionalNumber,
    sofaCoagulation: optionalNumber,
    sofaLiver: optionalNumber,
    sofaCardiovascular: optionalNumber,
    sofaCns: optionalNumber,
    sofaRenal: optionalNumber,
    sofaTotal: optionalNumber,
    apacheScore: optionalNumber,
    weight: optionalNumber,
  }),
});
