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

// 12 common lab tests covering the most-used hospital workflows.
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
