import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Gemini transport is a network call — stub it and assert on how the parser
// treats what comes back. What matters here is that a misbehaving model cannot
// put junk into a patient's lab record.
vi.mock('../../../../src/services/gemini-vision', () => ({
  callGeminiVision: vi.fn(),
  parseModelJson: <T,>(text: string): T => {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(cleaned) as T;
  },
  isOcrConfigured: vi.fn(() => true),
  OCR_SUPPORTED_MIME: new Set(['image/jpeg', 'image/png', 'application/pdf']),
}));

import { callGeminiVision, isOcrConfigured } from '../../../../src/services/gemini-vision';
import { parseLabReportFile, canOcrLabFile } from '../../../../src/modules/lab/lab.ocr';

const FILE = { path: '/uploads/report.pdf', mimetype: 'application/pdf', originalname: 'report.pdf' };

function reply(body: unknown) {
  (callGeminiVision as any).mockResolvedValue({
    text: JSON.stringify(body),
    model: 'gemini-2.5-flash',
  });
}

describe('lab report reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isOcrConfigured as any).mockReturnValue(true);
  });

  it('extracts analyte, value, unit and reference range', async () => {
    reply({
      parameters: [
        {
          testName: 'Complete Blood Count',
          parameterName: 'Haemoglobin',
          value: '9.1',
          unit: 'g/dL',
          normalRange: '13.0 - 17.0',
        },
      ],
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters).toEqual([
      {
        testName: 'Complete Blood Count',
        parameterName: 'Haemoglobin',
        value: '9.1',
        unit: 'g/dL',
        normalRange: '13.0 - 17.0',
      },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('keeps comparison markers verbatim instead of coercing to a number', async () => {
    reply({
      parameters: [
        { parameterName: 'Troponin I', value: '<0.01', unit: 'ng/mL', normalRange: '< 0.04' },
      ],
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters[0].value).toBe('<0.01');
  });

  it('drops rows with no analyte name — they cannot be stored against anything', async () => {
    reply({
      parameters: [
        { parameterName: '   ', value: '5' },
        { parameterName: 'ESR', value: '30', unit: 'mm/hr', normalRange: '0-20' },
        'not an object',
      ],
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters).toHaveLength(1);
    expect(res.parameters[0].parameterName).toBe('ESR');
  });

  it('keeps the first of a repeated analyte and says it did', async () => {
    reply({
      parameters: [
        { parameterName: 'Haemoglobin', value: '9.1' },
        { parameterName: 'haemoglobin', value: '9.1' },
      ],
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters).toHaveLength(1);
    expect(res.warnings[0]).toContain('duplicate');
  });

  it('warns rather than throws when the file yields nothing', async () => {
    reply({ parameters: [] });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters).toEqual([]);
    expect(res.warnings[0]).toContain('No lab parameters');
  });

  it('survives a model reply that is not JSON', async () => {
    (callGeminiVision as any).mockResolvedValue({
      text: 'Sorry, I cannot read this image.',
      model: 'gemini-2.5-flash',
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters).toEqual([]);
    expect(res.warnings[0]).toContain('Could not read');
  });

  it('unwraps a fenced json block', async () => {
    (callGeminiVision as any).mockResolvedValue({
      text: '```json\n{"parameters":[{"parameterName":"Urea","value":"22"}]}\n```',
      model: 'gemini-2.5-flash',
    });

    const res = await parseLabReportFile(FILE);

    expect(res.parameters[0]).toMatchObject({ parameterName: 'Urea', value: '22' });
  });

  describe('canOcrLabFile', () => {
    it('accepts images and PDFs when the key is configured', () => {
      expect(canOcrLabFile('application/pdf')).toBe(true);
      expect(canOcrLabFile('image/png')).toBe(true);
    });

    it('rejects file types the reader cannot take', () => {
      expect(canOcrLabFile('application/msword')).toBe(false);
    });

    it('rejects everything when no AI key is configured', () => {
      (isOcrConfigured as any).mockReturnValue(false);
      expect(canOcrLabFile('application/pdf')).toBe(false);
    });
  });
});
