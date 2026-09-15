import { describe, expect, it } from 'vitest';
import { reconcilePatientDoseQuantities } from '../../../../src/modules/ndps/ndps-patient-dose.service';

describe('NDPS patient dose reconciliation', () => {
  it('closes a fully administered container with no residual disposition', () => {
    const result = reconcilePatientDoseQuantities(50, 50);

    expect(result.labelledQuantity.toString()).toBe('50');
    expect(result.administeredQuantity.toString()).toBe('50');
    expect(result.residualQuantity.toString()).toBe('0');
    expect(result.disposition).toBe('none');
    expect(result.status).toBe('fully_administered');
  });

  it('calculates a partial dose and preserves immediate destruction', () => {
    const result = reconcilePatientDoseQuantities(50, 12.5, 'destroyed');

    expect(result.residualQuantity.toString()).toBe('37.5');
    expect(result.disposition).toBe('destroyed');
    expect(result.status).toBe('destroyed');
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
      'Choose immediate witnessed destruction or sealed quarantine for the residual.',
    );
  });
});
