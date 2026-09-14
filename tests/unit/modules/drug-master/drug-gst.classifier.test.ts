import { describe, expect, it } from 'vitest';
import {
  DRUG_GST_CLASSIFIER_VERSION,
  inferCatalogDrugGst,
} from '../../../../src/modules/drug-master/drug-gst.classifier';

describe('catalogue drug GST classifier', () => {
  it('classifies ordinary finished medicines at 5% without freezing treatment', () => {
    expect(inferCatalogDrugGst({ type: 'drug', name: 'Paracetamol 500 Tablet' })).toEqual({
      hsnCode: '3004', gstRate: 5, gstTreatment: null,
      classifierVersion: DRUG_GST_CLASSIFIER_VERSION,
      reason: 'Finished medicament; rate resolved from HSN master',
    });
  });

  it('uses the current 5% ORS tariff item', () => {
    expect(inferCatalogDrugGst({ type: 'drug', genericName: 'Oral Rehydration Salts' }))
      .toMatchObject({ hsnCode: '30049010', gstRate: 5, gstTreatment: null });
  });

  it('records a named-notification exemption explicitly', () => {
    expect(inferCatalogDrugGst({ type: 'drug', name: 'Daratumumab injection' }))
      .toMatchObject({ gstRate: 0, gstTreatment: 'exempt' });
  });

  it('leaves retail products unclassified because marketing category is not an HSN', () => {
    expect(inferCatalogDrugGst({ type: 'otc', name: 'Baby bottle' })).toBeNull();
  });
});
