import { describe, expect, it } from 'vitest';
import { allocateProportional, computeDocument, mulQty, pctOf, CalculationError, type CalcLine } from '../src/services/calculation.service.js';

const L = (over: Partial<CalcLine> = {}): CalcLine => ({ quantity: 1, unitPriceMinor: 1000, discountPct: 0, vatCode: 'A', vatRegime: 'taxable', vatRatePct: 19, ...over });

describe('arrondis', () => {
  it('mulQty / pctOf : demi vers le haut, sans erreur de virgule flottante', () => {
    expect(mulQty(1000, 1.5)).toBe(1500);
    expect(mulQty(333, 3)).toBe(999);
    expect(mulQty(1, 0.5)).toBe(1);          // 0,5 → 1
    expect(mulQty(1, 0.4)).toBe(0);
    expect(mulQty(10, 0.1 + 0.2)).toBe(3);   // 0.30000000000000004 ne fausse pas le calcul
    expect(pctOf(1005, 10)).toBe(101);       // 100,5 → 101
    expect(pctOf(1004, 10)).toBe(100);
    expect(pctOf(12345, 7.5)).toBe(926);     // 925,875 → 926
    expect(pctOf(1_000_000_000_000, 19)).toBe(190_000_000_000); // grands montants (BigInt)
  });
  it('répartition proportionnelle exacte (plus fort reste)', () => {
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportional(10, [0, 0])).toEqual([0, 0]);
    const r = allocateProportional(997, [3333, 3333, 3334]); expect(r.reduce((a, b) => a + b, 0)).toBe(997);
  });
});

describe('calcul d’un document', () => {
  it('une ligne à 19 % : HT, TVA, TTC', () => {
    const { totals, lines } = computeDocument({ lines: [L({ quantity: 2, unitPriceMinor: 10_500 })] }); // 21,000 DT
    expect(lines[0]).toEqual({ grossMinor: 21_000, discountMinor: 0, netHtMinor: 21_000, globalShareMinor: 0 });
    expect(totals).toMatchObject({ totalHtMinor: 21_000, totalVatMinor: 3_990, totalTtcMinor: 24_990, totalPayableMinor: 24_990 });
  });
  it('plusieurs taux (19, 13, 7, 0, exonéré, suspendu) : TVA par groupe, taux jamais imposé par défaut', () => {
    const r = computeDocument({ lines: [
      L({ vatCode: 'T19', vatRatePct: 19, unitPriceMinor: 100_000 }), L({ vatCode: 'T13', vatRatePct: 13, unitPriceMinor: 50_000 }),
      L({ vatCode: 'T7', vatRatePct: 7, unitPriceMinor: 20_000 }), L({ vatCode: 'T0', vatRegime: 'zero', vatRatePct: 0, unitPriceMinor: 10_000 }),
      L({ vatCode: 'EXO', vatRegime: 'exempt', vatRatePct: 19, unitPriceMinor: 10_000 }), // le taux fourni est ignoré pour un régime exonéré
      L({ vatCode: 'SUS', vatRegime: 'suspended', vatRatePct: 19, unitPriceMinor: 10_000 }),
    ] });
    expect(r.totals.vatGroups.map((g) => [g.vatCode, g.baseMinor, g.vatMinor])).toEqual([['T19', 100_000, 19_000], ['T13', 50_000, 6_500], ['T7', 20_000, 1_400], ['T0', 10_000, 0], ['EXO', 10_000, 0], ['SUS', 10_000, 0]]);
    expect(r.totals.vatGroups.find((g) => g.vatCode === 'EXO')!.ratePct).toBe(0);
    expect(r.totals).toMatchObject({ totalHtMinor: 200_000, totalVatMinor: 26_900, totalTtcMinor: 226_900 });
  });
  it('la TVA est calculée sur la base du taux (pas ligne par ligne) : pas d’écart d’arrondi', () => {
    // 3 lignes de 0,333 à 19 % : ligne par ligne = 3×63 = 189 ; sur la base 999 → 190
    const r = computeDocument({ lines: [L({ unitPriceMinor: 333 }), L({ unitPriceMinor: 333 }), L({ unitPriceMinor: 333 })] });
    expect(r.totals.totalHtMinor).toBe(999); expect(r.totals.totalVatMinor).toBe(190);
  });
  it('remise de ligne en pourcentage', () => {
    const r = computeDocument({ lines: [L({ quantity: 3, unitPriceMinor: 12_345, discountPct: 12.5 })] });
    expect(r.lines[0]).toEqual({ grossMinor: 37_035, discountMinor: 4_629, netHtMinor: 32_406, globalShareMinor: 0 }); // 4629,375 → 4629
    expect(r.totals.lineDiscountsMinor).toBe(4_629);
  });
  it('remise globale en % : appliquée par groupe de TVA avant calcul de la TVA', () => {
    const r = computeDocument({ globalDiscountPct: 10, lines: [L({ vatCode: 'A', vatRatePct: 19, unitPriceMinor: 100_000 }), L({ vatCode: 'B', vatRatePct: 7, unitPriceMinor: 50_000 })] });
    expect(r.totals.globalDiscountMinor).toBe(15_000);
    expect(r.totals.vatGroups.map((g) => [g.baseMinor, g.vatMinor])).toEqual([[90_000, 17_100], [45_000, 3_150]]);
    expect(r.totals.totalTtcMinor).toBe(135_000 + 20_250);
  });
  it('remise globale en montant : répartie sans perdre un millime', () => {
    const r = computeDocument({ globalDiscountMinor: 1_000, lines: [L({ vatCode: 'A', unitPriceMinor: 3_333 }), L({ vatCode: 'B', vatRatePct: 7, unitPriceMinor: 3_333 }), L({ vatCode: 'C', vatRatePct: 13, unitPriceMinor: 3_334 })] });
    expect(r.totals.globalDiscountMinor).toBe(1_000);
    expect(r.totals.totalHtMinor).toBe(10_000 - 1_000);
    expect(() => computeDocument({ globalDiscountMinor: 20_000, lines: [L()] })).toThrow(/dépasse/);
    expect(() => computeDocument({ globalDiscountMinor: 10, globalDiscountPct: 5, lines: [L()] })).toThrow(/OU/);
  });
  it('retenue à la source : base HT ou TTC, déduite du net à payer', () => {
    const base = { lines: [L({ unitPriceMinor: 100_000 })] }; // HT 100, TVA 19, TTC 119
    const ttc = computeDocument({ ...base, withholding: { ratePct: 1.5, base: 'ttc' } }).totals;
    expect(ttc.withholdingMinor).toBe(1_785); expect(ttc.totalPayableMinor).toBe(119_000 - 1_785);
    const ht = computeDocument({ ...base, withholding: { ratePct: 1.5, base: 'ht' } }).totals;
    expect(ht.withholdingMinor).toBe(1_500); expect(ht.totalPayableMinor).toBe(117_500);
    expect(computeDocument(base).totals.withholdingMinor).toBe(0);
  });
  it('timbre : ajouté au net à payer, hors assiette de TVA, TTC inchangé', () => {
    const t = computeDocument({ lines: [L({ unitPriceMinor: 100_000 })], stampMinor: 1_000, withholding: { ratePct: 1, base: 'ttc' } }).totals;
    expect(t.totalTtcMinor).toBe(119_000); expect(t.stampMinor).toBe(1_000); expect(t.withholdingMinor).toBe(1_190); expect(t.totalPayableMinor).toBe(119_000 + 1_000 - 1_190);
  });
  it('quantités décimales (3 décimales) et précision des devises', () => {
    expect(computeDocument({ lines: [L({ quantity: 0.125, unitPriceMinor: 8_000 })] }).lines[0]!.grossMinor).toBe(1_000);
    expect(computeDocument({ lines: [L({ quantity: 1.333, unitPriceMinor: 1_000 })] }).lines[0]!.grossMinor).toBe(1_333);
  });
  it('rejette les entrées invalides', () => {
    for (const bad of [{ lines: [] }, { lines: [L({ quantity: 0 })] }, { lines: [L({ quantity: -1 })] }, { lines: [L({ unitPriceMinor: -1 })] }, { lines: [L({ unitPriceMinor: 1.5 })] },
      { lines: [L({ discountPct: 101 })] }, { lines: [L({ discountPct: -1 })] }, { lines: [L()], stampMinor: -5 }, { lines: [L({ quantity: NaN })] }]) {
      expect(() => computeDocument(bad as never), JSON.stringify(bad)).toThrow(CalculationError);
    }
  });
  it('propriété : la somme des groupes égale toujours le total (aléatoire)', () => {
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => L({ vatCode: ['A', 'B', 'C'][Math.floor(rnd() * 3)]!, vatRatePct: [19, 13, 7][Math.floor(rnd() * 3)]!, quantity: Math.round(rnd() * 9000 + 1) / 1000, unitPriceMinor: Math.floor(rnd() * 500_000), discountPct: Math.round(rnd() * 3000) / 100 }));
      const r = computeDocument({ lines, globalDiscountPct: Math.round(rnd() * 2000) / 100 });
      const t = r.totals;
      expect(t.vatGroups.reduce((s, g) => s + g.baseMinor, 0)).toBe(t.totalHtMinor);
      expect(t.totalHtMinor).toBe(t.grossMinor - t.lineDiscountsMinor - t.globalDiscountMinor);
      expect(t.totalTtcMinor).toBe(t.totalHtMinor + t.totalVatMinor);
      expect(Number.isInteger(t.totalPayableMinor) && t.totalPayableMinor >= 0).toBe(true);
    }
  });
});
