# BillFlow

BillFlow is a lightweight React + Vite shop billing dashboard for GST-ready invoice tracking.

## Current features
- Dashboard overview with revenue, invoice, customer, and pending-payment stats.
- Revenue overview visualization and recent invoice activity.
- Invoice list with search, status labels, and responsive table layout.
- Create-invoice flow with local browser state for immediate feedback.
- Customers, Reports, and Settings sections with useful empty states and actions.
- Responsive layout for desktop, tablet, and mobile screens.
- BillFlow favicon and Inter/DM Sans typography styling.

## Entry routes
- `/` — Overview dashboard.
- `/invoices` — Searchable invoice list.
- `/customers` — Customer management starter view.
- `/reports` — Business reporting starter view.
- `/settings` — Business profile settings form.

## Data architecture
The restored frontend currently uses seeded in-memory demo data so the interface can be previewed without credentials. Supabase is listed as a dependency and `.env.example` documents the project credentials for a future persistence/authentication integration. No customer or invoice data is sent to a backend by the current UI.

## User guide
Open the Overview page to review shop activity. Use **Create invoice** to add an invoice, then find it from the Invoices route. Use the sidebar to switch between invoices, customers, reports, and business settings. The current create and save actions are local demo interactions.

## Not yet implemented
- Supabase authentication and persistent invoice/customer storage.
- PDF invoice generation, barcode/QR rendering, GST tax calculations, and WhatsApp reminders.
- Production reporting queries and multi-user permissions.

## Development
```bash
npm install
npm run dev
npm run build
npm run preview
```

## Deployment
- **Stack:** React 19, Vite 8, React Router, Tailwind CSS 4 tooling.
- **Configured target:** Vercel SPA rewrite via `vercel.json`.
- **Status:** Repaired locally; production deployment has not been run in this session.
- **Repository:** `https://github.com/shopbilling07-ship-it/shopbilling.git`
