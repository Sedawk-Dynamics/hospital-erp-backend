export interface SnomedSearchResult {
  conceptId: string;
  term: string; // preferred display term for this concept
}

export interface SnomedMapCandidate {
  icdCode: string;
  label: string;  
  advice: string;
}

export interface SnomedMapResult {
  snomedCode: string;
  status: 'resolved' | 'needs_detail' | 'unmapped';
  icdCodes: string[];                 
  candidates?: SnomedMapCandidate[];  
}

export interface PatientMapContext {
  gender?: string; 
  age?: number;
}