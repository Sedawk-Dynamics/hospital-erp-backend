import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type LabTestSeed = {
  testName: string;
  testCode: string;
  department: string;
  sampleType: string;
  unit?: string;
  normalRange?: string;
  price: number;
  turnaroundHours: number;
};

// Common lab tests covering the most-used hospital workflows.
// Department names are reused across tenants so we can group sensibly.
const LAB_TESTS: LabTestSeed[] = [
  {
    testName: 'Complete Blood Count (CBC)',
    testCode: 'CBC',
    department: 'Hematology',
    sampleType: 'Blood',
    unit: 'cells/µL',
    normalRange: 'WBC 4-11 K, Hb 12-17 g/dL',
    price: 350,
    turnaroundHours: 4,
  },
  {
    testName: 'Fasting Blood Sugar (FBS)',
    testCode: 'FBS',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: '70-100',
    price: 120,
    turnaroundHours: 2,
  },
  {
    testName: 'Postprandial Blood Sugar (PPBS)',
    testCode: 'PPBS',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: '<140',
    price: 150,
    turnaroundHours: 2,
  },
  {
    testName: 'Glycated Hemoglobin (HbA1c)',
    testCode: 'HBA1C',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: '%',
    normalRange: '4.0-5.6',
    price: 550,
    turnaroundHours: 6,
  },
  {
    testName: 'Lipid Profile',
    testCode: 'LIPID',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: 'TC <200, LDL <100, HDL >40',
    price: 700,
    turnaroundHours: 6,
  },
  {
    testName: 'Liver Function Test (LFT)',
    testCode: 'LFT',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'U/L',
    normalRange: 'Bilirubin 0.3-1.2, ALT 7-56, AST 10-40',
    price: 650,
    turnaroundHours: 6,
  },
  {
    testName: 'Kidney Function Test (KFT)',
    testCode: 'KFT',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: 'Urea 10-50, Creatinine 0.6-1.3',
    price: 600,
    turnaroundHours: 6,
  },
  {
    testName: 'Thyroid Profile (T3, T4, TSH)',
    testCode: 'TFT',
    department: 'Endocrinology',
    sampleType: 'Blood',
    unit: 'µIU/mL',
    normalRange: 'TSH 0.4-4.0',
    price: 750,
    turnaroundHours: 8,
  },
  {
    testName: 'Urine Routine & Microscopy',
    testCode: 'URM',
    department: 'Microbiology',
    sampleType: 'Urine',
    normalRange: 'No pus cells, no casts',
    price: 200,
    turnaroundHours: 4,
  },
  {
    testName: 'Dengue NS1 Antigen',
    testCode: 'DEN-NS1',
    department: 'Serology',
    sampleType: 'Blood',
    normalRange: 'Negative',
    price: 950,
    turnaroundHours: 6,
  },
  {
    testName: 'Malaria Parasite (Smear)',
    testCode: 'MP',
    department: 'Microbiology',
    sampleType: 'Blood',
    normalRange: 'No parasites seen',
    price: 250,
    turnaroundHours: 3,
  },
  {
    testName: 'COVID-19 RT-PCR',
    testCode: 'COVID-PCR',
    department: 'Microbiology',
    sampleType: 'Nasopharyngeal Swab',
    normalRange: 'Negative',
    price: 1200,
    turnaroundHours: 12,
  },
  {
    testName: 'Erythrocyte Sedimentation Rate (ESR)',
    testCode: 'ESR',
    department: 'Hematology',
    sampleType: 'Blood',
    unit: 'mm/hr',
    normalRange: 'M 0-15, F 0-20',
    price: 100,
    turnaroundHours: 3,
  },
  {
    testName: 'Peripheral Blood Smear',
    testCode: 'PBS',
    department: 'Hematology',
    sampleType: 'Blood',
    normalRange: 'Normocytic, normochromic',
    price: 200,
    turnaroundHours: 6,
  },
  {
    testName: 'Prothrombin Time with INR',
    testCode: 'PT-INR',
    department: 'Hematology',
    sampleType: 'Blood',
    unit: 'seconds',
    normalRange: 'PT 11-13.5, INR 0.8-1.1',
    price: 350,
    turnaroundHours: 4,
  },
  {
    testName: 'Activated Partial Thromboplastin Time (APTT)',
    testCode: 'APTT',
    department: 'Hematology',
    sampleType: 'Blood',
    unit: 'seconds',
    normalRange: '25-35',
    price: 350,
    turnaroundHours: 4,
  },
  {
    testName: 'Blood Grouping & Rh Typing',
    testCode: 'BG-RH',
    department: 'Hematology',
    sampleType: 'Blood',
    normalRange: 'A/B/AB/O with Rh+ or Rh-',
    price: 150,
    turnaroundHours: 2,
  },
  {
    testName: 'D-Dimer',
    testCode: 'DDIMER',
    department: 'Hematology',
    sampleType: 'Blood',
    unit: 'ng/mL',
    normalRange: '<500',
    price: 950,
    turnaroundHours: 4,
  },
  {
    testName: 'Serum Electrolytes (Na, K, Cl)',
    testCode: 'ELEC',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mEq/L',
    normalRange: 'Na 135-145, K 3.5-5.0, Cl 96-106',
    price: 400,
    turnaroundHours: 4,
  },
  {
    testName: 'Serum Calcium',
    testCode: 'CA',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: '8.5-10.5',
    price: 200,
    turnaroundHours: 4,
  },
  {
    testName: 'Serum Uric Acid',
    testCode: 'UA',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/dL',
    normalRange: 'M 3.4-7.0, F 2.4-6.0',
    price: 200,
    turnaroundHours: 4,
  },
  {
    testName: 'Vitamin D (25-OH)',
    testCode: 'VITD',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'ng/mL',
    normalRange: '30-100',
    price: 1200,
    turnaroundHours: 24,
  },
  {
    testName: 'Vitamin B12',
    testCode: 'VITB12',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'pg/mL',
    normalRange: '200-900',
    price: 850,
    turnaroundHours: 12,
  },
  {
    testName: 'Iron Studies (Iron, TIBC, Ferritin)',
    testCode: 'IRON',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'µg/dL',
    normalRange: 'Iron 60-170, TIBC 240-450, Ferritin 20-250',
    price: 900,
    turnaroundHours: 12,
  },
  {
    testName: 'Troponin I (Cardiac)',
    testCode: 'TROP-I',
    department: 'Cardiac Markers',
    sampleType: 'Blood',
    unit: 'ng/mL',
    normalRange: '<0.04',
    price: 800,
    turnaroundHours: 2,
  },
  {
    testName: 'C-Reactive Protein (CRP)',
    testCode: 'CRP',
    department: 'Biochemistry',
    sampleType: 'Blood',
    unit: 'mg/L',
    normalRange: '<10',
    price: 400,
    turnaroundHours: 6,
  },
  {
    testName: 'HIV 1 & 2 Antibody',
    testCode: 'HIV',
    department: 'Serology',
    sampleType: 'Blood',
    normalRange: 'Non-reactive',
    price: 500,
    turnaroundHours: 8,
  },
  {
    testName: 'Hepatitis B Surface Antigen (HBsAg)',
    testCode: 'HBSAG',
    department: 'Serology',
    sampleType: 'Blood',
    normalRange: 'Non-reactive',
    price: 350,
    turnaroundHours: 8,
  },
  {
    testName: 'Hepatitis C Antibody (Anti-HCV)',
    testCode: 'HCV',
    department: 'Serology',
    sampleType: 'Blood',
    normalRange: 'Non-reactive',
    price: 450,
    turnaroundHours: 8,
  },
  {
    testName: 'Widal Test',
    testCode: 'WIDAL',
    department: 'Serology',
    sampleType: 'Blood',
    normalRange: 'Titre <1:80',
    price: 250,
    turnaroundHours: 4,
  },
  {
    testName: 'Urine Culture & Sensitivity',
    testCode: 'UR-CS',
    department: 'Microbiology',
    sampleType: 'Urine',
    normalRange: 'No growth',
    price: 600,
    turnaroundHours: 72,
  },
  {
    testName: 'Stool Routine & Microscopy',
    testCode: 'STOOL-RM',
    department: 'Microbiology',
    sampleType: 'Stool',
    normalRange: 'No ova/cysts/parasites',
    price: 200,
    turnaroundHours: 4,
  },
  {
    testName: 'Sputum AFB Smear',
    testCode: 'AFB',
    department: 'Microbiology',
    sampleType: 'Sputum',
    normalRange: 'No AFB seen',
    price: 250,
    turnaroundHours: 24,
  },
  {
    testName: 'Pap Smear',
    testCode: 'PAP',
    department: 'Cytology',
    sampleType: 'Cervical Swab',
    normalRange: 'Negative for intraepithelial lesion',
    price: 700,
    turnaroundHours: 48,
  },
];

async function seedTenant(tenantId: string, tenantName: string) {
  let createdTests = 0;
  let skippedTests = 0;
  const departmentCache = new Map<string, string>();

  for (const test of LAB_TESTS) {
    let departmentId = departmentCache.get(test.department);
    if (!departmentId) {
      const department =
        (await prisma.labDepartment.findFirst({
          where: { tenantId, name: test.department },
        })) ??
        (await prisma.labDepartment.create({
          data: { tenantId, name: test.department, isActive: true },
        }));
      departmentId = department.id;
      departmentCache.set(test.department, departmentId);
    }

    const existing = await prisma.labTestCatalog.findFirst({
      where: { tenantId, testName: test.testName },
    });
    if (existing) {
      skippedTests++;
      continue;
    }

    await prisma.labTestCatalog.create({
      data: {
        tenantId,
        labDepartmentId: departmentId,
        testName: test.testName,
        testCode: test.testCode,
        sampleType: test.sampleType,
        unit: test.unit,
        normalRange: test.normalRange,
        price: test.price,
        turnaroundHours: test.turnaroundHours,
        isActive: true,
      },
    });
    createdTests++;
  }

  console.log(
    `  ${tenantName.padEnd(30)} ${createdTests} created, ${skippedTests} already present`,
  );
}

async function main() {
  console.log(`Seeding ${LAB_TESTS.length} default lab tests per tenant...\n`);

  const tenants = await prisma.tenant.findMany({
    where: { slug: { not: '__platform__' }, isActive: true },
    select: { id: true, name: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });

  if (tenants.length === 0) {
    console.log('No hospital tenants found. Create a hospital first, then re-run.');
    return;
  }

  for (const tenant of tenants) {
    await seedTenant(tenant.id, `${tenant.name} (${tenant.slug})`);
  }

  console.log(`\n✅ Done. Seeded ${tenants.length} tenant(s).`);
}

main()
  .catch((err) => {
    console.error('❌ Lab test seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
