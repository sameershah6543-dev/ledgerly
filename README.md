# Ledgerly - Shop accounts made simple

Record what you sell, what you spend and what you stock - Ledgerly works out your revenue, profit and stock for you.

## Run it

```
npm install        # once
npm start          # http://localhost:3000
```
On Windows you can also double-click **start.bat**. Sign in with **admin / Admin@123** (change it in *Settings*).

## The screens

| Tab | What it's for |
|---|---|
| **Dashboard** | Sales, profit, expenses and net profit for the period, a 6-month chart, cash/bank balances, low-stock alerts and one-click *Record a sale / Add an expense / Add stock*. |
| **Sales** | Every sale. *Record a sale*: pick the product, quantity and price; the cost comes from your stock and you can change it (or type the profit) for that sale. Selling something not in inventory adds it automatically. |
| **Expenses** | Rent, bills, salaries... pick a category (or create one) and where it was paid from. |
| **Inventory** | Products, stock on hand, cost, selling price, profit per unit and stock value. *Add stock* records units you bought. Click a product for its history. |
| **Profit & Loss** | Sales - cost of products sold - expenses = net profit, for this month, last month, this year, last year or all time. Printable. |
| **Settings** | Business name, currency, password, backup, and *Start fresh* (delete all entries, keeping settings). |

The database starts with one demo product, one sale and one expense. `npm run seed` resets to that demo;
set `NO_SAMPLE=1` to start empty. Other variables: `PORT`, `DATA_DIR`, `DB_PATH`, `ADMIN_PASSWORD`.
Requires Node.js 20+.

Tests: `npm test` (accounting + simple-mode flows), `npm run test:ui` (drives the real forms in headless Edge).

## Deploy (Vercel + Turso, free)

The app runs on a local SQLite file by default. When `TURSO_DATABASE_URL` is set it uses that Turso
database instead - that is how it runs on Vercel (`api/index.js` + `vercel.json`, static files from `public/`).

| Vercel environment variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://....turso.io` from the Turso dashboard |
| `TURSO_AUTH_TOKEN` | database token from the Turso dashboard |
| `ADMIN_PASSWORD` | password for the `admin` login (applied when the database is first set up) |
| `APP_TIMEZONE` | `Asia/Karachi` (Vercel servers run on UTC) |
| `NO_SAMPLE` | `1` to start without the demo entries (optional) |

Before the first deploy you can verify the database: put the URL and token in `.env` (see `.env.example`) and run
`node --env-file=.env test/turso-check.mjs` - it tests a full sale/expense/stock cycle, then empties the database again.

## How it works

Every business document (expense, invoice, receipt, payment, transfer, capital entry, liability, asset,
stock return…) is saved in **one database transaction** that also (re)builds its **journal entry** and
**stock movements** and writes the **audit record**. If any rule is violated the whole transaction rolls back.
Nothing is stored twice: the Trial Balance, P&L, Balance Sheet, Cash Flow, dashboard, account balances,
customer/supplier balances and aging are all computed from the general ledger.

| You enter | Ledger effect (automatic) |
|---|---|
| Customer invoice | Dr Accounts Receivable · Cr Revenue · Cr Sales Tax Payable · Dr COGS / Cr Inventory (stock items, weighted-average cost) |
| Receipt | Dr Cash/Bank · Cr Accounts Receivable (reduces the invoice) |
| Purchase invoice | Dr Inventory *or* Expense · Dr Input Tax · Cr Accounts Payable (stock increases) |
| Supplier payment | Dr Accounts Payable · Cr Cash/Bank |
| Expense (paid) | Dr Expense · Cr Cash/Bank — (unpaid) Dr Expense · Cr Accounts Payable, settled later by a Payment |
| Owner investment / drawing | Dr Cash · Cr Owner Capital / Dr Drawings · Cr Cash |
| Transfer | Dr receiving account · Cr sending account — never revenue or expense |
| Loan / liability | Dr Cash (or Expense / Opening balance) · Cr Liability; repayments via Payments |
| Asset purchase, depreciation, disposal | Dr Asset · Cr Cash; Dr Depreciation Expense · Cr Accumulated Depreciation; gain/loss on disposal |
| Sales / purchase return, stock adjustment | Reverse revenue/cost and stock, credit or refund |

Rules enforced by the system: debits = credits on every entry; Assets = Liabilities + Equity; profit flows to
equity (prior years to retained earnings, current year shown separately); receipts/payments cannot exceed
what is outstanding; stock can never go negative; cash/bank accounts cannot be overdrawn (switchable in
Settings); documents with payments cannot be deleted/cancelled until those are removed; edits re-post the ledger.
*Settings → Data & backup → Run check* verifies all of this (and that stock, receivables and payables agree
with the ledger) on demand.

## Tests

```
npm test                                    # accounting engine + simple-mode flows (local database)
npm run test:ui                             # drives the real forms in headless Edge
node --env-file=.env test/turso-check.mjs   # one-time check against Turso before deploying
```

## Design notes & known limits

* Backend: Node + Express + libSQL/SQLite - a local file, or Turso online (`server/`), vanilla-JS single-page frontend (`public/`), no build step.
  Money is stored as rounded decimals; journal balance is checked in integer cents.
* Inventory uses **weighted-average cost**. Editing an old purchase re-values stock but does not restate the cost
  of earlier sales. Purchase-return value equals the unit cost entered.
* One currency at a time (PKR by default; change in Settings — existing amounts are not converted).
* Sales tax is a simple per-line percentage (output tax payable / input tax receivable), no tax-return module.
* A receipt/payment settles one document (or is left “on account”). No bank reconciliation, recurring
  entries, budgets, multi-company or period locking.
* The overdraft guard compares total balances, not day-by-day balances.
* Backups: *Settings → Download backup* gives a JSON copy of all data. Turso also keeps its own point-in-time backups.
