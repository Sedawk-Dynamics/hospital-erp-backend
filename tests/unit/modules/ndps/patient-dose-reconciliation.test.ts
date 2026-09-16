import { describe, expect, it } from 'vitest';
import { reconcilePatientDoseQuantities } from '../../../../src/modules/ndps/ndps-patient-dose.service';
import { ndpsPatientDoseSchema } from '../../../../src/modules/emar/emar.validation';

describe('NDPS patient dose reconciliation', () => {
  it('closes a fully administered container with no residual disposition', () => {
    const result = reconcilePatientDoseQuantities(50, 50);

    expect(result.labelledQuantity.toString()).toBe('50');
    expect(result.administeredQuantity.toString()).toBe('50');
    expect(result.residualQuantity.toString()).toBe('0');
    expect(result.disposition).toBe('none');
    expect(result.status).toBe('fully_administered');
  });

  it('does not allow bedside staff to record immediate destruction', () => {
    expect(() => reconcilePatientDoseQuantities(50, 12.5, 'destroyed')).toThrow(
      'Residual destruction cannot be recorded during patient administration.',
    );
  });

  it('defaults an unresolved residual to quarantine, never back to stock', () => {
    const result = reconcilePatientDoseQuantities(2, 0.75);

    expect(result.residualQuantity.toString()).toBe('1.25');
    expect(result.disposition).toBe('quarantined');
    expect(result.status).toBe('quarantined');
  });

  it('rejects an administered quantity above the label', () => {
    expect(() => reconcilePatientDoseQuantities(10, 10.1)).toThrow(
      'Administered quantity cannot exceed the labelled quantity.',
    );
  });

  it('rejects more than four decimal places', () => {
    expect(() => reconcilePatientDoseQuantities(1.00001, 1)).toThrow(
      'Labelled quantity can have at most four decimal places.',
    );
  });

  it('does not allow a positive residual to be marked as none', () => {
    expect(() => reconcilePatientDoseQuantities(10, 5, 'none')).toThrow(
      'A positive remainder must be sealed and quarantined for authorised NDPS disposal.',
    );
  });

  it('rejects bedside destruction fields at the eMAR API boundary', () => {
    const result = ndpsPatientDoseSchema.safeParse({
      drugBatchId: '11111111-1111-4111-8111-111111111111',
      ndpsLocationId: '22222222-2222-4222-8222-222222222222',
      labelledQuantity: 2,
      administeredQuantity: 0.5,
      quantityUnit: 'mL',
      containerQuantity: 1,
      disposition: 'destroyed',
      disposalMethod: 'bedside destruction',
      witnessedById: '33333333-3333-4333-8333-333333333333',
      witnessPassword: 'secret',
    });

    expect(result.success).toBe(false);
  });
});
