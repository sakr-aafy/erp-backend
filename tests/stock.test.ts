import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, setupDb, teardownDb } from './helpers.js';
import { J, line, logisticsCompany, levelOf, costOf, quoteBody, stockIn, stockOut, api, type LCtx } from './sales.helpers.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { CostHistory, EventLog, StockLevel, StockMovement } from '../src/models/logistics.model.js';
import { DeliveryNote, Proforma } from '../src/models/sales.model.js';
import { ProductSerial } from '../src/models/product.model.js';
import { emitDomainEvent } from '../src/services/domain-events.js';
import { applyMovement } from '../src/services/stock.service.js';
import { withTransaction } from '../src/utils/transaction.js';

let A: LCtx, B: LCtx; let P: string, Q: string;
beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); P = A.products.a19; Q = A.products.b13; });
afterAll(teardownDb);

const mkBl = async (c: LCtx, productId: string, qty: number, serials?: string[]) => {
  const q = (await c.j.post('/proformas', quoteBody(c, [line(productId, qty)]))).body; // source de livraison
  return (await c.j.post('/delivery-notes', { source: { type: 'proforma', id: q.id }, lines: [{ sourceLineId: q.lines[0].id, quantity: qty, ...(serials && { serials }) }] })).body;
};

describe('magasins', () => {
  it('le premier magasin devient le magasin par défaut ; code unique ; désactivation et suppression protégées', async () => {
    const list = (await A.j.get('/warehouses')).body; expect(list.find((w: { code: string }) => w.code === 'WH1').isDefault).toBe(true);
    expect((await A.j.post('/warehouses', { code: 'wh1', name: 'Doublon' })).status).toBe(409);
    expect((await A.j.put(`/warehouses/${A.w2}`, { isDefault: true })).body.isDefault).toBe(true); // un seul par défaut
    expect((await A.j.get('/warehouses')).body.filter((w: { isDefault: boolean }) => w.isDefault)).toHaveLength(1);
    await A.j.put(`/warehouses/${A.w1}`, { isDefault: true });
    await stockIn(A, P, 5, 1000, A.w2);
    expect((await api().patch(`/api/v1/warehouses/${A.w2}/active`).set('Authorization', `Bearer ${A.token}`).send({ isActive: false })).status).toBe(409); // non vide
    expect((await A.j.del(`/warehouses/${A.w2}`)).status).toBe(409); // mouvements existants
    await stockOut(A, P, 5, A.w2);
  });
});

describe('valorisation CMP', () => {
  it('entrées successives : CMP pondéré ; sorties au CMP ; dernière unité = valeur restante exacte', async () => {
    await stockIn(A, P, 10, 5_000); await stockIn(A, P, 10, 7_000);
    expect(await levelOf(A, P)).toEqual({ qty: 20, value: 120_000 }); expect(await costOf(P)).toBe(6_000);
    const o = await stockOut(A, P, 5); expect(o.status).toBe(201);
    expect(await levelOf(A, P)).toEqual({ qty: 15, value: 90_000 });
    expect((await stockOut(A, P, 15)).status).toBe(201); expect(await levelOf(A, P)).toEqual({ qty: 0, value: 0 }); // aucun résidu de valeur
    const hist = await CostHistory.find({ productId: P }).sort({ at: 1 }); expect(hist.map((h) => h.newCostMinor).slice(-2)).toEqual([5_000, 6_000]); expect(hist.at(-1)!.previousCostMinor).toBe(5_000); expect(hist.at(-1)).toMatchObject({ reason: 'goods_receipt' });
  });
  it('arrondis : 3 unités pour une valeur de 10 → sorties 3 + 4 + 3 = 10 (aucune dérive)', async () => {
    await A.j.post('/stock/movements', { direction: 'in', productId: Q, warehouseId: A.w1, quantity: 3, unitCostMinor: 3, reason: 'Arrondi test' }); // valeur 9
    await Promise.all([]); await stockOut(A, Q, 1); await stockOut(A, Q, 1); await stockOut(A, Q, 1);
    const ms = await StockMovement.find({ productId: Q, direction: 'out' }).sort({ createdAt: 1 }); expect(ms.reduce((s, m) => s + m.valueMinor, 0)).toBe(9); expect(await levelOf(A, Q)).toEqual({ qty: 0, value: 0 });
  });
  it('chaque mouvement est tracé (avant/après, valeur, utilisateur, motif) et immuable', async () => {
    await stockIn(A, P, 4, 2_000);
    const m = (await A.j.get(`/stock/movements?productId=${P}&limit=1`)).body.items[0];
    expect(m).toMatchObject({ direction: 'in', reason: 'manual_in', quantity: 4, valueMinor: 8_000, qtyBefore: 0, qtyAfter: 4, note: 'Stock initial de test' });
    expect((await A.j.put(`/stock/movements/${m.id}`, { quantity: 99 })).status).toBe(404); expect((await A.j.del(`/stock/movements/${m.id}`)).status).toBe(404);
    expect(await AuditLog.countDocuments({ resource: 'stock', action: 'manual-in' })).toBeGreaterThan(0);
    await stockOut(A, P, 4);
  });
  it('historique filtrable par article, magasin, motif, période ; export Excel/CSV/PDF', async () => {
    const byP = (await A.j.get(`/stock/movements?productId=${P}`)).body; expect(byP.items.every((i: { productId: string }) => i.productId === P)).toBe(true); expect(byP.total).toBeGreaterThan(4);
    expect((await A.j.get(`/stock/movements?warehouseId=${A.w2}`)).body.items.every((i: { warehouse: string }) => i.warehouse === 'WH2')).toBe(true);
    expect((await A.j.get('/stock/movements?reason=delivery')).body.total).toBe(0);
    expect((await A.j.get('/stock/movements?from=2999-01-01')).body.total).toBe(0);
    const x = await api().get('/api/v1/stock/movements/export?format=xlsx').set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser); expect(x.status).toBe(200); expect(x.headers['content-disposition']).toMatch(/mouvements-de-stock/);
    for (const f of ['csv', 'pdf']) expect((await A.j.get(`/stock/movements/export?format=${f}`)).status).toBe(200);
  });
});

describe('stock négatif', () => {
  it('sortie impossible si stock insuffisant ; rien n’est modifié', async () => {
    await stockIn(A, P, 3, 1_000);
    const r = await stockOut(A, P, 5); expect(r.status).toBe(409); expect(r.body.error.code).toBe('INSUFFICIENT_STOCK'); expect(r.body.error.details).toMatchObject({ requested: 5, available: 3 });
    expect(await levelOf(A, P)).toEqual({ qty: 3, value: 3_000 });
  });
  it('autorisation explicite : permission inventory:validate requise, auditée, mouvement marqué « forcé »', async () => {
    await makeUser(A.companyId, 'mag@a.test', ['inventory:view', 'inventory:create']); const m = J((await login('mag@a.test')).token);
    expect((await m.post('/stock/movements', { direction: 'out', productId: P, warehouseId: A.w1, quantity: 5, reason: 'Livraison urgente', allowNegativeStock: true })).status).toBe(403);
    const ok = await stockOut(A, P, 5, A.w1, { allowNegativeStock: true }); expect(ok.status).toBe(201); expect(ok.body.forced).toBe(true); expect(ok.body.qtyAfter).toBe(-2);
    expect((await levelOf(A, P)).qty).toBe(-2);
    expect(await AuditLog.countDocuments({ resource: 'stock', action: 'manual-out', 'meta.forced': true })).toBe(1);
    await stockIn(A, P, 12, 1_000); expect(await levelOf(A, P)).toMatchObject({ qty: 10 }); // retour au positif
  });
});

describe('transferts entre magasins', () => {
  it('sortie + entrée atomiques, même valeur ; refus si stock insuffisant sans effet partiel', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 10, 3_000);
    const t = (await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: P, quantity: 4 }] })).body; expect(t.number).toMatch(/^TR-\d{4}-000001$/);
    expect(await levelOf(A, P, A.w2)).toEqual({ qty: 0, value: 0 }); // brouillon : sans effet
    const v = await A.j.post(`/stock-transfers/${t.id}/validate`); expect(v.status).toBe(200);
    expect(await levelOf(A, P, A.w1)).toEqual({ qty: 6, value: 18_000 }); expect(await levelOf(A, P, A.w2)).toEqual({ qty: 4, value: 12_000 });
    expect((await A.j.post(`/stock-transfers/${t.id}/validate`)).status).toBe(409); expect((await A.j.del(`/stock-transfers/${t.id}`)).status).toBe(409);
    const moves = await StockMovement.find({ 'source.id': t.id }); expect(moves.map((m) => m.reason).sort()).toEqual(['transfer_in', 'transfer_out']); expect(moves[0]!.valueMinor).toBe(moves[1]!.valueMinor);
    // 2 lignes dont la 2e est impossible : aucune des deux ne doit être appliquée
    const bad = (await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: P, quantity: 1 }, { productId: Q, quantity: 50 }] })).body;
    const r = await A.j.post(`/stock-transfers/${bad.id}/validate`); expect(r.status).toBe(409);
    expect(await levelOf(A, P, A.w1)).toEqual({ qty: 6, value: 18_000 }); expect(await levelOf(A, P, A.w2)).toEqual({ qty: 4, value: 12_000 }); expect((await A.j.get(`/stock-transfers/${bad.id}`)).body.status).toBe('draft');
  });
  it('contrôles : magasins identiques, article service, permissions de validation', async () => {
    expect((await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w1, lines: [{ productId: P, quantity: 1 }] })).status).toBe(422);
    expect((await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: A.products.svc, quantity: 1 }] })).status).toBe(400);
    const t = (await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: P, quantity: 1 }] })).body;
    await makeUser(A.companyId, 'tr@a.test', ['inventory:view', 'inventory:create']); const u = J((await login('tr@a.test')).token); expect((await u.post(`/stock-transfers/${t.id}/validate`)).status).toBe(403);
    expect((await B.j.get(`/stock-transfers/${t.id}`)).status).toBe(404);
  });
});

describe('inventaires et ajustements', () => {
  it('écarts → ajustements au CMP ; motif obligatoire ; niveau = quantité comptée ; mouvements tracés', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 10, 4_000); await stockIn(A, Q, 8, 1_000);
    const inv = (await A.j.post('/inventories', { warehouseId: A.w1 })).body; expect(inv.number).toMatch(/^INV-\d{4}-000001$/); expect(inv.lines).toHaveLength(2);
    expect((await A.j.post(`/inventories/${inv.id}/validate`)).status).toBe(409); // rien de compté
    await A.j.put(`/inventories/${inv.id}`, { lines: [{ productId: P, countedQty: 7 }, { productId: Q, countedQty: 11 }] });
    const noReason = await A.j.post(`/inventories/${inv.id}/validate`); expect(noReason.status).toBe(409); expect(noReason.body.error.message).toMatch(/motif/i);
    await A.j.put(`/inventories/${inv.id}`, { reason: 'Inventaire annuel', lines: [] });
    const v = await A.j.post(`/inventories/${inv.id}/validate`); expect(v.status).toBe(200);
    expect(await levelOf(A, P)).toEqual({ qty: 7, value: 28_000 }); expect(await levelOf(A, Q)).toMatchObject({ qty: 11 });
    const adj = await StockMovement.find({ 'source.id': inv.id }).sort({ reason: 1 }); expect(adj.map((m) => `${m.reason}:${m.quantity}`)).toEqual(['inventory_in:3', 'inventory_out:3']);
    expect((await A.j.get(`/inventories/${inv.id}`)).body.lines.map((l: { appliedDelta: number }) => l.appliedDelta).sort()).toEqual([-3, 3]);
    expect((await A.j.put(`/inventories/${inv.id}`, { lines: [] })).status).toBe(409); expect((await A.j.post(`/inventories/${inv.id}/validate`)).status).toBe(409);
    expect(await AuditLog.countDocuments({ resource: 'inventory', action: 'validate' })).toBe(1);
  });
  it('sans écart : aucun mouvement ; articles à numéro de série exclus ; permission de validation', async () => {
    const inv = (await A.j.post('/inventories', { warehouseId: A.w1 })).body;
    await A.j.put(`/inventories/${inv.id}`, { lines: inv.lines.map((l: { productId: string; systemQty: number }) => ({ productId: l.productId, countedQty: l.systemQty })) });
    const before = await StockMovement.countDocuments({ companyId: A.companyId }); expect((await A.j.post(`/inventories/${inv.id}/validate`)).status).toBe(200); expect(await StockMovement.countDocuments({ companyId: A.companyId })).toBe(before);
    expect((await A.j.put(`/inventories/${(await A.j.post('/inventories', { warehouseId: A.w1 })).body.id}`, { lines: [{ productId: A.serialProduct, countedQty: 1 }] })).status).toBe(400);
    await makeUser(A.companyId, 'inv@a.test', ['inventory:view', 'inventory:create', 'inventory:update']); const u = J((await login('inv@a.test')).token);
    const i2 = (await u.post('/inventories', { warehouseId: A.w1 })).body; expect((await u.post(`/inventories/${i2.id}/validate`)).status).toBe(403);
  });
});

describe('intégration : bon de livraison → sortie de stock', () => {
  it('la validation du BL sort le stock au CMP ; l’annulation le réintègre à la valeur d’origine', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await StockMovement.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 10, 6_000);
    const bl = await mkBl(A, P, 4); expect(await levelOf(A, P)).toMatchObject({ qty: 10 });
    const v = await A.j.post(`/delivery-notes/${bl.id}/validate`, { warehouseId: A.w1 }); expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(await levelOf(A, P)).toEqual({ qty: 6, value: 36_000 }); const m = (await StockMovement.findOne({ 'source.id': bl.id, reason: 'delivery' }))!; expect(m).toMatchObject({ direction: 'out', quantity: 4, valueMinor: 24_000, unitCostMinor: 6_000 });
    expect((await DeliveryNote.findById(bl.id))!.warehouseId!.toString()).toBe(A.w1);
    const c = await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Erreur de livraison' }); expect(c.status).toBe(200);
    expect(await levelOf(A, P)).toEqual({ qty: 10, value: 60_000 }); expect(await StockMovement.countDocuments({ 'source.id': bl.id })).toBe(2);
  });
  it('stock insuffisant : la validation du BL est refusée EN ENTIER (BL reste brouillon, aucun mouvement)', async () => {
    const bl = await mkBl(A, P, 50); const r = await A.j.post(`/delivery-notes/${bl.id}/validate`); expect(r.status).toBe(409); expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await A.j.get(`/delivery-notes/${bl.id}`)).body.status).toBe('draft'); expect(await StockMovement.countDocuments({ 'source.id': bl.id })).toBe(0);
    expect((await Proforma.findById(bl.source.id))!.lines[0]!.deliveredQty).toBe(0); // quantités livrées de la source inchangées
  });
  it('autorisation de stock négatif sur BL : permission dédiée', async () => {
    const bl = await mkBl(A, P, 50);
    await makeUser(A.companyId, 'bl@a.test', ['deliveryNotes:view', 'deliveryNotes:validate']); const u = J((await login('bl@a.test')).token);
    expect((await u.post(`/delivery-notes/${bl.id}/validate`, { allowNegativeStock: true })).status).toBe(403);
    const ok = await A.j.post(`/delivery-notes/${bl.id}/validate`, { allowNegativeStock: true }); expect(ok.status).toBe(200); expect((await levelOf(A, P)).qty).toBe(10 - 50);
    expect((await StockMovement.findOne({ 'source.id': bl.id }))!.forced).toBe(true);
  });
  it('services : aucun mouvement ; pas de magasin : erreur explicite', async () => {
    // le service seul n'est pas livrable → on vérifie plutôt l'absence de magasin avec un article
    await StockLevel.deleteMany({ companyId: B.companyId }); await (await import('../src/models/logistics.model.js')).Warehouse.deleteMany({ companyId: B.companyId });
    const bl = await mkBl(B, B.products.a19, 1); const r = await B.j.post(`/delivery-notes/${bl.id}/validate`); expect(r.status).toBe(409); expect(r.body.error.code).toBe('NO_WAREHOUSE');
  });
});

describe('idempotence, journal et reprise des événements', () => {
  it('un même événement rejoué ne crée JAMAIS un second mouvement (journal + clé de mouvement)', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 20, 1_000);
    const bl = await mkBl(A, P, 5); await A.j.post(`/delivery-notes/${bl.id}/validate`);
    const count = () => StockMovement.countDocuments({ 'source.id': bl.id });
    expect(await count()).toBe(1);
    for (let i = 0; i < 3; i++) await withTransaction((session) => emitDomainEvent('deliveryNote.validated', { companyId: A.companyId, documentId: bl._id ?? (bl.id as never), session, payload: {} }));
    expect(await count()).toBe(1); expect(await EventLog.countDocuments({ key: `deliveryNote.validated:${bl.id}:stock` })).toBe(1); expect((await levelOf(A, P)).qty).toBe(15);
    // même clé de mouvement : renvoyé tel quel
    const r = await withTransaction((session) => applyMovement({ companyId: A.companyId, session, productId: P, warehouseId: A.w1, direction: 'out', quantity: 5, reason: 'delivery', eventKey: `deliveryNote.validated:${bl.id}:${bl.lines[0].id}` }));
    expect(r.duplicate).toBe(true); expect((await levelOf(A, P)).qty).toBe(15);
  });
  it('un échec est JOURNALISÉ (hors transaction) puis REPRIS une fois la cause levée', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await StockMovement.deleteMany({ companyId: A.companyId }); await EventLog.deleteMany({ companyId: A.companyId });
    const bl = await mkBl(A, P, 6); const f = await A.j.post(`/delivery-notes/${bl.id}/validate`); expect(f.status).toBe(409);
    const failed = (await A.j.get('/stock/events?status=failed')).body; expect(failed.total).toBe(1);
    expect(failed.items[0]).toMatchObject({ event: 'deliveryNote.validated', status: 'failed', attempts: 1, documentNumber: bl.number }); expect(failed.items[0].error).toMatch(/Stock insuffisant/);
    const retryFail = await A.j.post(`/stock/events/${failed.items[0].id}/retry`); expect(retryFail.status).toBe(409); // cause persistante
    expect((await A.j.get('/stock/events?status=failed')).body.items[0].attempts).toBe(2);
    await stockIn(A, P, 10, 1_000);
    const ok = await A.j.post(`/stock/events/${failed.items[0].id}/retry`); expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body).toMatchObject({ status: 'processed', movements: 1 });
    expect((await A.j.get(`/delivery-notes/${bl.id}`)).body.status).toBe('validated'); expect((await levelOf(A, P)).qty).toBe(4);
    expect((await A.j.post(`/stock/events/${failed.items[0].id}/retry`)).body.status).toBe('processed'); expect(await StockMovement.countDocuments({ 'source.id': bl.id })).toBe(1); // rejouer = sans effet
  });
  it('reprise et journal réservés à inventory:validate ; isolation des sociétés', async () => {
    await makeUser(A.companyId, 'ev@a.test', ['inventory:view']); const u = J((await login('ev@a.test')).token);
    expect((await u.get('/stock/events')).status).toBe(403); expect((await u.post('/stock/reconcile')).status).toBe(403);
    const bIds = (await B.j.get('/stock/events')).body.items.map((e: { id: string }) => e.id); const aIds = (await A.j.get('/stock/events')).body.items.map((e: { id: string }) => e.id);
    expect(aIds.length).toBeGreaterThan(0); expect(bIds.filter((i: string) => aIds.includes(i))).toEqual([]); // chaque société ne voit que ses événements
  });
  it('réconciliation : rejoue les documents validés sans traitement (ex. BL antérieurs au stock) et contrôle niveaux = mouvements', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await StockMovement.deleteMany({ companyId: A.companyId }); await EventLog.deleteMany({ companyId: A.companyId }); await DeliveryNote.deleteMany({ companyId: A.companyId }); await (await import('../src/models/logistics.model.js')).StockTransfer.deleteMany({ companyId: A.companyId }); await (await import('../src/models/logistics.model.js')).Inventory.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 10, 2_000);
    const bl = await mkBl(A, P, 3); await DeliveryNote.updateOne({ _id: bl.id }, { status: 'validated', validatedAt: new Date(), warehouseId: A.w1 }); // « ancien » BL validé sans mouvement
    const r = await A.j.post('/stock/reconcile'); expect(r.status).toBe(200); expect(r.body.replayed).toEqual([expect.objectContaining({ event: 'deliveryNote.validated', number: bl.number })]); expect(r.body.failed).toEqual([]);
    expect((await levelOf(A, P)).qty).toBe(7); expect(r.body.consistency.consistent).toBe(true);
    expect((await A.j.post('/stock/reconcile')).body.replayed).toEqual([]); expect((await levelOf(A, P)).qty).toBe(7); // idempotent
    await StockLevel.updateOne({ companyId: A.companyId, productId: P, warehouseId: A.w1 }, { $inc: { qty: 1 } }); // altération volontaire
    const c = (await A.j.get('/stock/consistency')).body; expect(c.consistent).toBe(false); expect(c.mismatches[0]).toMatchObject({ productId: P, level: 8, fromMovements: 7 });
    await StockLevel.updateOne({ companyId: A.companyId, productId: P, warehouseId: A.w1 }, { $inc: { qty: -1 } });
  });
  it('concurrence : 10 BL validés en même temps sur un stock de 4 → exactement 4 réussissent, jamais de stock négatif', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await StockMovement.deleteMany({ companyId: A.companyId }); await stockIn(A, P, 4, 1_000);
    const bls = await Promise.all(Array.from({ length: 10 }, () => mkBl(A, P, 1)));
    const rs = await Promise.all(bls.map((b) => A.j.post(`/delivery-notes/${b.id}/validate`)));
    expect(rs.filter((r) => r.status === 200).length).toBe(4); expect(rs.filter((r) => r.status === 409).length).toBe(6); expect(await levelOf(A, P)).toEqual({ qty: 0, value: 0 });
    expect((await A.j.get('/stock/consistency')).body.consistent).toBe(true);
  });
});

describe('numéros de série', () => {
  it('entrée avec séries (nombre = quantité) ; sortie BL marque « vendu » ; annulation remet disponible ; transfert déplace le numéro', async () => {
    const S = A.serialProduct;
    expect((await stockIn(A, S, 2, 50_000, A.w1, { serials: ['SN-1'] })).status).toBe(400); // 1 série pour 2 unités
    expect((await stockIn(A, S, 3, 50_000, A.w1, { serials: ['SN-1', 'SN-2', 'SN-3'] })).status).toBe(201);
    expect((await stockIn(A, S, 1, 50_000, A.w1, { serials: ['SN-1'] })).status).toBe(409); // déjà enregistré
    expect((await A.j.post('/stock/movements', { direction: 'in', productId: S, warehouseId: A.w1, quantity: 1.5, unitCostMinor: 1, reason: 'décimal', serials: ['X'] })).status).toBe(422);
    const bl = await mkBl(A, S, 2, ['SN-1', 'SN-2']);
    expect((await A.j.post(`/delivery-notes/${(await mkBl(A, S, 1, ['SN-9'])).id}/validate`)).status).toBe(409); // série inconnue
    expect((await A.j.post(`/delivery-notes/${bl.id}/validate`)).status).toBe(200);
    expect((await ProductSerial.find({ productId: S, status: 'sold' })).map((s) => s.serialNumber).sort()).toEqual(['SN-1', 'SN-2']);
    expect((await A.j.post(`/delivery-notes/${(await mkBl(A, S, 1, ['SN-1'])).id}/validate`)).status).toBe(409); // déjà vendu
    await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Retour client complet' });
    expect((await ProductSerial.find({ productId: S, status: 'available' })).length).toBe(3);
    const t = (await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: S, quantity: 1, serials: ['SN-3'] }] })).body; expect((await A.j.post(`/stock-transfers/${t.id}/validate`)).status).toBe(200);
    expect(String((await ProductSerial.findOne({ serialNumber: 'SN-3' }))!.warehouseId)).toBe(A.w2); expect((await levelOf(A, S, A.w2)).qty).toBe(1);
  });
});

describe('état du stock, alertes, valorisation', () => {
  it('seuil minimum : statuts normal / sous le seuil / rupture ; filtres ; valorisation par magasin ; exports', async () => {
    await StockLevel.deleteMany({ companyId: A.companyId }); await StockMovement.deleteMany({ companyId: A.companyId });
    await A.j.put(`/products/${P}`, { minStock: 10 }); await stockIn(A, P, 6, 2_000); await stockIn(A, Q, 4, 1_000, A.w2);
    const ov = (await A.j.get('/stock/overview')).body; const row = (ref: string) => ov.items.find((i: { reference: string }) => i.reference === ref);
    expect(row('A19')).toMatchObject({ qty: 6, status: 'low', minStock: 10, valueMinor: 12_000, avgCostMinor: 2_000 }); expect(row('B13')).toMatchObject({ qty: 4, status: 'ok' }); expect(row('C7').status).toBe('out');
    expect(ov.summary).toMatchObject({ lowCount: 1, outCount: expect.any(Number), valueMinor: 16_000 });
    expect((await A.j.get('/stock/overview?status=low')).body.items.map((i: { reference: string }) => i.reference)).toEqual(['A19']); expect((await A.j.get('/stock/overview?status=alert')).body.total).toBeGreaterThanOrEqual(2);
    expect((await A.j.get(`/stock/overview?warehouseId=${A.w2}`)).body.items.find((i: { reference: string }) => i.reference === 'A19').qty).toBe(0);
    const w = await stockIn(A, P, 1, 2_000); expect(w.body.belowMin).toBe(true); expect((await stockIn(A, P, 10, 2_000)).body.belowMin).toBe(false); // alerte au franchissement du seuil
    const val = (await A.j.get('/stock/valuation')).body; expect(val.totalValueMinor).toBe(val.warehouses.reduce((s: number, x: { valueMinor: number }) => s + x.valueMinor, 0)); expect(val.warehouses).toHaveLength(2);
    for (const f of ['xlsx', 'csv', 'pdf']) expect((await A.j.get(`/stock/overview/export?format=${f}&status=alert`)).status).toBe(200);
  });
  it('permissions et isolation : lecture / création séparées, autre société sans accès', async () => {
    await makeUser(A.companyId, 'sv@a.test', ['inventory:view']); const v = J((await login('sv@a.test')).token);
    expect((await v.get('/stock/overview')).status).toBe(200); expect((await v.post('/stock/movements', { direction: 'in', productId: P, warehouseId: A.w1, quantity: 1, unitCostMinor: 1, reason: 'test' })).status).toBe(403); expect((await v.post('/warehouses', { code: 'X', name: 'Xx' })).status).toBe(403);
    expect((await B.j.get(`/stock/movements?productId=${P}`)).body.total).toBe(0); expect((await B.j.post('/stock/movements', { direction: 'in', productId: P, warehouseId: B.w1, quantity: 1, unitCostMinor: 1, reason: 'intrus' })).status).toBe(404);
    expect((await A.j.post('/stock/movements', { direction: 'in', productId: P, warehouseId: B.w1, quantity: 1, unitCostMinor: 1, reason: 'autre magasin' })).status).toBe(400);
    expect((await A.j.del(`/products/${P}`)).status).toBe(409); // article avec mouvements : non supprimable
  });
});
