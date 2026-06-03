import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import {
  parseCsv,
  drugIdentityKey,
  nppaIdentityKey,
} from './drug-master.dataset';

// Official NPPA / DPCO ceiling-price import. Super-admin uploads the NPPA
// published list (converted to CSV) with columns:
//   formulation, strength, dosage_form, unit, ceiling_price, notification,
//   effective_date
// Only `formulation` and `ceiling_price` are required. The importer upserts the
// NppaCeilingPrice reference table and then flags matching DrugMaster rows
// (single-salt, by salt+strength) as scheduled with the ceiling. It NEVER reads
// or writes any hospital's DrugFormulary/DrugBatch — ceilings are shared
// platform reference data.

export interface NppaSummary {
  rows: number;
  ceilingsUpserted: number;
  drugsMatched: number;
  ceilingsUnmatched: number;
}

type NppaStatus = 'idle' | 'running' | 'success' | 'error';

interface NppaState {
  status: NppaStatus;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  result: NppaSummary | null;
  error: string | null;
}

let state: NppaState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  source: null,
  result: null,
  error: null,
};

export function getNppaStatus(): NppaState {
  return state;
}

interface NppaRow {
  formulation: string;
  strength: string | null;
  dosageForm: string | null;
  unit: string | null;
  ceilingPrice: number;
  notification: string | null;
  effectiveDate: Date | null;
  matchKey: string;
}

function parseNppaCsv(text: string): NppaRow[] {
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  const idx = (...names: string[]) =>
    header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const cForm = idx('formulation', 'drug', 'name', 'generic');
  const cStr = idx('strength');
  const cForm2 = idx('dosage_form', 'dosageform', 'form');
  const cUnit = idx('unit');
  const cPrice = idx('ceiling_price', 'ceilingprice', 'price', 'ceiling price (rs)', 'ceiling price');
  const cNotif = idx('notification', 'so', 'order');
  const cDate = idx('effective_date', 'effectivedate', 'effective');

  const out: NppaRow[] = [];
  for (const r of rows) {
    const formulation = (r[cForm] ?? '').trim();
    const priceRaw = (r[cPrice] ?? '').trim().replace(/[^0-9.]/g, '');
    if (!formulation || !priceRaw || Number.isNaN(Number(priceRaw))) continue;
    const strength = cStr >= 0 ? (r[cStr] ?? '').trim() || null : null;
    const dateRaw = cDate >= 0 ? (r[cDate] ?? '').trim() : '';
    const parsedDate = dateRaw ? new Date(dateRaw) : null;
    out.push({
      formulation,
      strength,
      dosageForm: cForm2 >= 0 ? (r[cForm2] ?? '').trim() || null : null,
      unit: cUnit >= 0 ? (r[cUnit] ?? '').trim() || null : null,
      ceilingPrice: Number(priceRaw),
      notification: cNotif >= 0 ? (r[cNotif] ?? '').trim() || null : null,
      effectiveDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      matchKey: nppaIdentityKey(formulation, strength) ?? `${formulation}|${strength ?? ''}`.toLowerCase(),
    });
  }
  return out;
}

export async function importNppaFromCsv(csvText: string): Promise<NppaSummary> {
  const parsed = parseNppaCsv(csvText);
  if (parsed.length === 0) {
    throw AppError.badRequest('No valid NPPA rows found (need formulation + ceiling_price columns)');
  }

  // Dedupe by matchKey (last wins) then upsert the reference table.
  const byKey = new Map<string, NppaRow>();
  for (const row of parsed) byKey.set(row.matchKey, row);

  for (const row of byKey.values()) {
    await prisma.nppaCeilingPrice.upsert({
      where: { matchKey: row.matchKey },
      create: {
        formulation: row.formulation,
        strength: row.strength,
        dosageForm: row.dosageForm,
        unit: row.unit,
        ceilingPrice: row.ceilingPrice,
        notification: row.notification,
        effectiveDate: row.effectiveDate,
        matchKey: row.matchKey,
      },
      update: {
        formulation: row.formulation,
        strength: row.strength,
        dosageForm: row.dosageForm,
        unit: row.unit,
        ceilingPrice: row.ceilingPrice,
        notification: row.notification,
        effectiveDate: row.effectiveDate,
      },
    });
  }

  // Re-match from scratch: clear existing scheduled flags first (only the
  // already-flagged subset — cheap), then re-apply against the full ceiling set.
  await prisma.drugMaster.updateMany({
    where: { isScheduled: true },
    data: {
      isScheduled: false,
      ceilingPrice: null,
      ceilingUnit: null,
      nppaNotification: null,
      ceilingEffectiveDate: null,
    },
  });

  // Match DrugMaster rows by salt+strength identity (single or combination).
  const drugs = await prisma.drugMaster.findMany({ select: { id: true, genericName: true } });
  const matchedKeys = new Set<string>();
  const updates: Array<{ id: string; row: NppaRow }> = [];
  for (const d of drugs) {
    const key = drugIdentityKey(d.genericName);
    if (!key) continue;
    const ceiling = byKey.get(key);
    if (ceiling) {
      updates.push({ id: d.id, row: ceiling });
      matchedKeys.add(key);
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((u) =>
        prisma.drugMaster.update({
          where: { id: u.id },
          data: {
            isScheduled: true,
            ceilingPrice: u.row.ceilingPrice,
            ceilingUnit: u.row.unit,
            nppaNotification: u.row.notification,
            ceilingEffectiveDate: u.row.effectiveDate,
          },
        }),
      ),
    );
  }

  const summary: NppaSummary = {
    rows: parsed.length,
    ceilingsUpserted: byKey.size,
    drugsMatched: updates.length,
    ceilingsUnmatched: byKey.size - matchedKeys.size,
  };
  logger.info(summary, 'NPPA ceiling prices imported');
  return summary;
}

export function startNppaImport(opts: { csvText: string; sourceLabel: string }): NppaState {
  if (state.status === 'running') {
    throw AppError.conflict('An NPPA import is already in progress');
  }
  state = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    source: opts.sourceLabel,
    result: null,
    error: null,
  };

  (async () => {
    try {
      const result = await importNppaFromCsv(opts.csvText);
      state = { ...state, status: 'success', finishedAt: new Date().toISOString(), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'NPPA import failed';
      logger.error({ err }, 'NPPA import failed');
      state = { ...state, status: 'error', finishedAt: new Date().toISOString(), error: message };
    }
  })();

  return state;
}
