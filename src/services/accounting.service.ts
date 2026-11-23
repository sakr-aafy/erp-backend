import type { ClientSession, Types } from 'mongoose';
import { AccountingSettings, JournalEntry, JOURNALS, type Journal, type JournalEntryDoc } from '../models/finance.model.js';
import { AppError } from '../utils/errors.js';
import { ensureCounter, nextDocumentNumber } from './numbering.service.js';
import { startOfDay } from './fiscal.service.js';

type Id = Types.ObjectId; type Role = JournalEntryDoc['lines'][number]['role'];
export interface EntryLineInput { role: Role; label?: string | undefined; debitMinor?: number; creditMinor?: number; accountCode?: string | null | undefined; thirdPartyId?: Id | undefined; treasuryAccountId?: Id | undefined }

/** À appeler AVANT d'ouvrir une transaction qui peut produire des écritures (compteurs de journaux : cf. `ensureCounter`). */
export async function ensureFinanceCounters(companyId: Id) { for (const j of JOURNALS) await ensureCounter(companyId, `journal_${j}`); }

export async function accountMap(companyId: Id, session?: ClientSession): Promise<Record<string, string>> {
  const s = await AccountingSettings.findOne({ companyId }).session(session ?? null).lean();
  return s?.accounts ? Object.fromEntries(s.accounts instanceof Map ? s.accounts : Object.entries(s.accounts)) : {};
}

/**
 * Enregistre UNE écriture équilibrée pour un événement métier. Idempotent : `eventKey` unique (jamais deux écritures pour le même événement).
 * Les lignes à zéro sont omises ; Σ débit = Σ crédit est vérifié (sinon l'opération entière échoue et est journalisée).
 */
export async function postEntry(p: { companyId: Id; session: ClientSession; journal: Journal; date: Date; label: string; eventKey: string; source: { type: string; id: Id; number?: string | undefined }; lines: EntryLineInput[]; reversal?: boolean }) {
  const dup = await JournalEntry.findOne({ companyId: p.companyId, eventKey: p.eventKey }).session(p.session).lean();
  if (dup) return { entry: dup, duplicate: true };
  const map = await accountMap(p.companyId, p.session);
  const lines = p.lines.filter((l) => (l.debitMinor ?? 0) !== 0 || (l.creditMinor ?? 0) !== 0).map((l) => ({ role: l.role, label: l.label, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0,
    accountCode: l.accountCode ?? map[l.role] ?? undefined, thirdPartyId: l.thirdPartyId, treasuryAccountId: l.treasuryAccountId }));
  if (!lines.length) return { entry: null, duplicate: false };
  const debit = lines.reduce((s, l) => s + l.debitMinor, 0); const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (debit !== credit || lines.some((l) => l.debitMinor < 0 || l.creditMinor < 0 || (l.debitMinor > 0 && l.creditMinor > 0))) throw new AppError(500, `Écriture déséquilibrée (débit ${debit} ≠ crédit ${credit}) : ${p.label}`, 'UNBALANCED_ENTRY');
  const number = await nextDocumentNumber(p.companyId, `journal_${p.journal}`, p.session, p.date);
  const [e] = await JournalEntry.create([{ companyId: p.companyId, journal: p.journal, number, date: startOfDay(p.date), label: p.label, source: p.source, eventKey: p.eventKey, lines, totalMinor: debit, reversal: !!p.reversal }] as never[], { session: p.session });
  return { entry: e!.toObject(), duplicate: false };
}
export const swapSides = (lines: EntryLineInput[]): EntryLineInput[] => lines.map((l) => ({ ...l, debitMinor: l.creditMinor ?? 0, creditMinor: l.debitMinor ?? 0 }));
