/**
 * Mesure de performance de l'API (latences réelles, HTTP) sur une base de volume (cf. seed-perf.ts).
 * Usage : API=http://localhost:3000 EMAIL=perf@example.com PASSWORD='…' npm run perf [itérations]
 * Sortie : tableau Markdown (médiane, p95, max, taille de réponse) + écart-type ; code de sortie 1 si un budget est dépassé.
 */
const API = process.env['API'] ?? 'http://localhost:3000'; const EMAIL = process.env['EMAIL'] ?? 'perf@example.com'; const PASSWORD = process.env['PASSWORD'] ?? '';
const N = Number(process.argv[2] ?? 10);
if (!PASSWORD) { console.error('PASSWORD requis (base de volume uniquement).'); process.exit(2); }
const login = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const token = ((await login.json()) as { accessToken?: string }).accessToken; if (!token) { console.error('Connexion impossible'); process.exit(2); }
const y = new Date().getUTCFullYear(); const R = `from=${y - 1}-01-01&to=${y}-12-31`;
interface T { name: string; path: string; budgetMs: number }
const REPORTS = ['sales-by-period', 'sales-by-customer', 'sales-by-product', 'sales-by-category', 'sales-by-user', 'quotations', 'invoices-status', 'credit-notes', 'receivables-aging', 'payables-aging', 'receipts', 'disbursements', 'expenses-by-category', 'treasury-by-account', 'cashflow',
  'stock-by-warehouse', 'stock-valuation', 'stock-movements', 'stock-low', 'stock-out', 'inventories', 'transfers', 'valuation-history', 'purchases-by-supplier', 'purchases-by-period', 'purchase-invoices', 'orders-pending', 'partial-receipts', 'purchase-gaps', 'purchase-price-variances',
  'imports-by-period', 'import-costs', 'import-charges', 'exchange-rates'];
const tests: T[] = [
  { name: 'GET /customers?q= (recherche)', path: '/customers?q=Client%200042&limit=20', budgetMs: 150 }, { name: 'GET /customers (page 1)', path: '/customers?page=1&limit=20', budgetMs: 150 }, { name: 'GET /customers (page 50)', path: '/customers?page=50&limit=20', budgetMs: 200 },
  { name: 'GET /products?q= (recherche)', path: '/products?q=ART-0150&limit=20', budgetMs: 200 }, { name: 'GET /products (page 100)', path: '/products?page=100&limit=20', budgetMs: 250 },
  { name: 'GET /invoices (page 1)', path: '/invoices?page=1&limit=20', budgetMs: 250 }, { name: 'GET /invoices (filtre impayées)', path: '/invoices?paymentStatus=unpaid&limit=20', budgetMs: 400 }, { name: 'GET /invoices/summary', path: '/invoices/summary', budgetMs: 500 },
  { name: 'GET /stock/overview', path: '/stock/overview?limit=20', budgetMs: 600 }, { name: 'GET /stock/movements (page 1)', path: '/stock/movements?limit=20', budgetMs: 250 }, { name: 'GET /accounting/receivables', path: '/accounting/receivables', budgetMs: 800 },
  { name: 'GET /reports/dashboard (mois)', path: '/reports/dashboard', budgetMs: 1500 }, { name: 'GET /reports/dashboard (année)', path: `/reports/dashboard?from=${y}-01-01&to=${y}-12-31`, budgetMs: 2000 },
  ...REPORTS.map((k) => ({ name: `GET /reports/${k}`, path: `/reports/${k}?${R}&limit=50`, budgetMs: 2000 })),
  { name: 'EXPORT xlsx sales-by-product', path: `/reports/sales-by-product/export?format=xlsx&${R}`, budgetMs: 4000 }, { name: 'EXPORT xlsx stock-by-warehouse (6 000 lignes)', path: '/reports/stock-by-warehouse/export?format=xlsx', budgetMs: 5000 },
  { name: 'EXPORT csv purchase-invoices', path: `/reports/purchase-invoices/export?format=csv&${R}`, budgetMs: 3000 }, { name: 'EXPORT pdf sales-by-customer', path: `/reports/sales-by-customer/export?format=pdf&${R}`, budgetMs: 4000 },
];
// Fiche client : onglets mesurés sur le client le plus actif (plus gros solde)
const top = ((await (await fetch(`${API}/api/v1/customers?sort=-balanceMinor&limit=1`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { items: { id: string }[] }).items[0];
if (top) tests.push(
  { name: 'GET /customers (filtres type+statut+ville)', path: '/customers?type=company&status=active&city=Tunis&limit=20', budgetMs: 200 }, { name: 'GET /customers?sort=-code', path: '/customers?sort=-code&limit=20', budgetMs: 200 },
  { name: 'GET /customers/:id/summary', path: `/customers/${top.id}/summary`, budgetMs: 500 }, { name: 'GET /customers/:id/transactions', path: `/customers/${top.id}/transactions?limit=20`, budgetMs: 400 },
  { name: 'GET /customers/:id/payments', path: `/customers/${top.id}/payments`, budgetMs: 500 }, { name: 'GET /customers/:id/activities', path: `/customers/${top.id}/activities`, budgetMs: 400 },
  { name: 'GET /customers/:id/documents', path: `/customers/${top.id}/documents`, budgetMs: 200 }, { name: 'EXPORT csv relevé client', path: `/customers/${top.id}/statement?format=csv`, budgetMs: 800 });
// Fiche article : onglets mesurés sur un article réel de la base de volume
const prod = ((await (await fetch(`${API}/api/v1/products?limit=1&q=ART-0150`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { items: { id: string }[] }).items[0];
tests.push(
  { name: 'GET /products (statut + marque + tri)', path: '/products?status=active&sort=-salePriceMinor&limit=20', budgetMs: 250 }, { name: 'GET /products?stockState=out', path: '/products?stockState=out&limit=20', budgetMs: 1500 }, { name: 'GET /products?stockState=below_min', path: '/products?stockState=below_min&limit=20', budgetMs: 1500 },
  { name: 'GET /products?q= (code, marque, modèle, fournisseur)', path: '/products?q=ART-01&limit=20', budgetMs: 250 }, { name: 'GET /products/brands', path: '/products/brands', budgetMs: 200 });
if (prod) tests.push(
  { name: 'GET /products/:id', path: `/products/${prod.id}`, budgetMs: 250 }, { name: 'GET /products/:id/stock', path: `/products/${prod.id}/stock`, budgetMs: 300 }, { name: 'GET /products/:id/transactions', path: `/products/${prod.id}/transactions?limit=20`, budgetMs: 800 },
  { name: 'GET /products/:id/documents', path: `/products/${prod.id}/documents`, budgetMs: 300 }, { name: 'GET /products/:id/activities', path: `/products/${prod.id}/activities`, budgetMs: 500 }, { name: 'EXPORT csv transactions article', path: `/products/${prod.id}/transactions/export?format=csv`, budgetMs: 1200 },
  { name: 'EXPORT xlsx catalogue', path: '/products/export?format=xlsx', budgetMs: 4000 });
const pctl = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const rows: string[] = []; let over = 0;
for (const t of tests) {
  const times: number[] = []; let size = 0; let status = 200;
  for (let i = 0; i < N + 1; i++) {
    const t0 = performance.now(); const r = await fetch(`${API}/api/v1${t.path}`, { headers: { Authorization: `Bearer ${token}` } }); const b = await r.arrayBuffer(); const dt = performance.now() - t0; status = r.status; size = b.byteLength; if (i > 0) times.push(dt); // i = 0 : échauffement (cache de plans/connexions)
  }
  times.sort((a, b) => a - b); const med = pctl(times, 50); const p95 = pctl(times, 95); const bad = status !== 200 || p95 > t.budgetMs; if (bad) over++;
  rows.push(`| ${t.name} | ${status} | ${med.toFixed(0)} | ${p95.toFixed(0)} | ${times.at(-1)!.toFixed(0)} | ${(size / 1024).toFixed(1)} | ${t.budgetMs} | ${bad ? '⚠️' : '✓'} |`);
}
console.log(`Itérations mesurées par appel : ${N} (+1 d'échauffement) — API ${API}\n`); console.log('| Appel | HTTP | médiane ms | p95 ms | max ms | Ko | budget p95 ms | |\n|---|---|---|---|---|---|---|---|'); console.log(rows.join('\n'));
console.log(`\n${over ? `⚠️ ${over} appel(s) hors budget` : 'Tous les appels respectent leur budget'}`); process.exit(over ? 1 : 0);
