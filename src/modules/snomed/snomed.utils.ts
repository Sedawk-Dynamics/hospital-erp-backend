import { PatientMapContext } from "./snomed.types";

const SNOMED_FEMALE = '248152002';
const SNOMED_MALE = '248153007';

export function ruleSatisfied(rule: string | null, ctx?: PatientMapContext): boolean {
  if (!rule) return false;
  const r = rule.toUpperCase();
  if (r.includes('OTHERWISE TRUE')) return true;
  if (r === 'TRUE') return true;
  if (rule.includes(SNOMED_FEMALE) || r.includes('FEMALE')) {
    return ctx?.gender?.toLowerCase() === 'female';
  }
  if (rule.includes(SNOMED_MALE) || r.includes('MALE')) {
    return ctx?.gender?.toLowerCase() === 'male';
  }
  return false;
}

export function labelFromAdvice(advice: string | null): string {
  if (!advice) return '';
  const parts = advice.split('|').map((s) => s.trim());
  return parts[parts.length - 1] || '';
}