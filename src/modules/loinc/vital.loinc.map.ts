export const VITAL_LOINC_MAP = {
  bloodPressureSystolic:  '8480-6',
  bloodPressureDiastolic: '8462-4',
  pulseRate:              '8867-4',
  temperature:           '8310-5',
  respiratoryRate:       '9279-1',
  oxygenSaturation:      '2708-6',
  weightKg:              '29463-7',
  heightCm:              '8302-2',
  bmi:                   '39156-5',
  bloodSugar:            '2339-0',
} as const;

// UCUM unit code for each vital's valueQuantity (unitsofmeasure.org).
export const VITAL_UCUM_MAP: Record<keyof typeof VITAL_LOINC_MAP, string> = {
  bloodPressureSystolic:  'mm[Hg]',
  bloodPressureDiastolic: 'mm[Hg]',
  pulseRate:              '/min',
  temperature:           'Cel',
  respiratoryRate:       '/min',
  oxygenSaturation:      '%',
  weightKg:              'kg',
  heightCm:              'cm',
  bmi:                   'kg/m2',
  bloodSugar:            'mg/dL',
} as const;
