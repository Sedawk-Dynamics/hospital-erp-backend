import { PatientMapContext } from './snomed.types';

const SNOMED_FEMALE = '248152002';
const SNOMED_MALE = '248153007';

export function ruleSatisfied(rule: string | null, ctx?: PatientMapContext): boolean {
  if (!rule) return false;
  const normalizedRule = rule.toUpperCase();
  if (normalizedRule.includes('OTHERWISE TRUE')) return true;
  if (normalizedRule === 'TRUE') return true;
  if (rule.includes(SNOMED_FEMALE) || normalizedRule.includes('FEMALE')) {
    return ctx?.gender?.toLowerCase() === 'female';
  }
  if (rule.includes(SNOMED_MALE) || normalizedRule.includes('MALE')) {
    return ctx?.gender?.toLowerCase() === 'male';
  }
  return false;
}

export function labelFromAdvice(advice: string | null): string {
  if (!advice) return '';
  const parts = advice.split('|').map((part) => part.trim());
  return parts[parts.length - 1] || '';
}
