import { randomUUID } from 'crypto';
import { prisma } from '../../src/config/database';
import {
  createFormularyItem,
  createOpeningBatch,
  getFormularyItemById,
  importFormularyItem,
  previewPharmacySale,
} from '../../src/modules/pharmacy/pharmacy.service';
import { getUnifiedStock } from '../../src/modules/inventory/inventory.service';
import { classifyFormularyItem } from '../../src/modules/drug-master/drug-schedule.service';
import { searchFormulary } from '../../src/modules/prescriptions/prescriptions.service';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  assert(tenant, 'No tenant is available for the retail-product walk');

  const suffix = randomUUID().slice(0, 8);
  const name = `E2E Nutrition Product ${suffix}`;
  const createdIds: string[] = [];

  try {
    const created = await createFormularyItem(tenant.id, ['super_admin'], {
      drugName: name,
      category: 'product',
      productCategory: 'Nutrition',
      manufacturer: 'E2E Maker',
      unitOfMeasurement: 'Bottle',
      looseUnitLabel: 'Bottle',
      packSize: 1,
      hsnCode: '2106',
      taxPercent: 18,
      price: 125,
      minStock: 3,
      isReimbursable: false,
      force: true,
    });
    assert(created.status === 'created', 'Manual product was not created');
    createdIds.push(created.item.id);
    assert(created.item.category === 'product', 'Manual product category was not retained');
    assert(created.item.productCategory === 'Nutrition', 'Retail shelf category was not retained');
    assert(created.item.schedule == null, 'Retail product incorrectly received a drug schedule');

    const batch = await createOpeningBatch(tenant.id, created.item.id, {
      quantity: 7,
      purchasePrice: 80,
      sellingPrice: 125,
    });

    const stock = await getUnifiedStock(tenant.id, { search: name, page: 1, limit: 20 });
    const row = stock.data.find((item) => item.refId === created.item.id);
    assert(row?.category === 'product', 'Product was not returned by unified storage');
    assert(row.productCategory === 'Nutrition', 'Unified storage omitted the product category');
    assert(row.currentStock === 7 && row.batchCount === 1, 'Opening batch did not reach live stock');

    await classifyFormularyItem(created.item.id);
    const afterClassifier = await getFormularyItemById(tenant.id, created.item.id);
    assert(afterClassifier.schedule == null, 'Classifier did not ignore the retail product');

    const prescriptionResults = await searchFormulary(tenant.id, { search: name });
    assert(
      !prescriptionResults.some((item) => item.id === created.item.id),
      'Retail product leaked into the prescription picker',
    );

    const quote = await previewPharmacySale(tenant.id, {
      items: [{ drugBatchId: batch.id, quantity: 2 }],
    });
    assert(quote.lines.length === 1, 'POS preview did not price the retail product');
    assert(quote.totals.totalAmount > 0, 'POS preview returned an empty product price');

    const otcCandidates = await prisma.drugMaster.findMany({
      where: { type: 'otc', isPublished: true, isDiscontinued: false, productCategory: { not: null } },
      select: { id: true, name: true, productCategory: true },
      take: 25,
      orderBy: { id: 'asc' },
    });
    let importedOtc: (typeof otcCandidates)[number] | undefined;
    for (const candidate of otcCandidates) {
      const existing = await prisma.drugFormulary.findFirst({
        where: { tenantId: tenant.id, drugMasterId: candidate.id },
        select: { id: true },
      });
      if (!existing) {
        importedOtc = candidate;
        break;
      }
    }
    assert(importedOtc, 'Could not find an unimported OTC catalogue row for the walk');

    const imported = await importFormularyItem(tenant.id, ['super_admin'], {
      drugMasterId: importedOtc.id,
    });
    assert(imported.status === 'created', 'OTC catalogue row was not imported');
    createdIds.push(imported.item.id);
    assert(imported.item.category === 'product', 'OTC catalogue row was imported as a medicine');
    assert(
      imported.item.productCategory === importedOtc.productCategory,
      'OTC product category did not carry into storage',
    );
    assert(imported.item.schedule == null, 'OTC product incorrectly inherited a drug schedule');

    console.log(`PASS tenant: ${tenant.name}`);
    console.log('PASS manual product: create -> opening batch -> unified storage -> POS preview');
    console.log('PASS clinical boundary: classifier ignored it; prescription search excluded it');
    console.log(`PASS OTC catalogue import: ${importedOtc.name} -> ${importedOtc.productCategory}`);
  } finally {
    if (createdIds.length) {
      await prisma.drugBatch.deleteMany({ where: { drugId: { in: createdIds } } });
      await prisma.drugFormulary.deleteMany({ where: { id: { in: createdIds } } });
      await prisma.auditLog.deleteMany({
        where: { entityType: 'drug_formulary', entityId: { in: createdIds } },
      }).catch(() => undefined);
    }
  }
}

main()
  .catch((error) => {
    console.error('FAIL retail-product walk:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
