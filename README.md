# BillFlow

BillFlow is a responsive React + Vite point-of-sale and GST billing workspace for small shops.

## Completed features
- Supabase Auth login and signup with email-confirmation handling, validation, and friendly errors.
- Safe preview fallback when `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are not configured.
- Role-based navigation and route guards for Owner, Employee, and Customer roles.
- Owner-only overview, reports, customer management, and settings; Employee POS access; Customer invoice history access.
- Continuous camera barcode scanning with the browser `BarcodeDetector` API, plus manual barcode/SKU entry.
- Product search, instant cart add/increment, quantity controls, item removal, subtotal, GST, and total calculations.
- Digital invoice creation and public shareable `/invoice/:id` receipt routes that load without authentication.
- Responsive desktop, tablet, and mobile POS layout.
- Netlify SPA redirect configuration for client-side routes.

## Entry routes
- `/` — Owner overview dashboard.
- `/pos` — Owner/Employee POS, scanner, product search, and cart.
- `/invoices` — Searchable invoice list available to signed-in users.
- `/invoice/:id` — Shareable itemized digital invoice; public read-only route.
- `/customers` — Owner-only customer management area.
- `/reports` — Owner-only sales analytics area.
- `/settings` — Owner-only workspace configuration area.

## Environment
Copy `.env.example` to `.env.local` and provide:
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
If either value is missing, the app intentionally runs in browser-only demo mode and displays a visible notice. Configure Supabase Auth email settings as desired; signup automatically signs in when a session is returned, otherwise the UI asks the user to confirm their email.

## Data architecture
- Supabase Auth is used when configured; role is read from `user_metadata.role`.
- Demo products and invoice data are local seeded data.
- Demo invoices persist in browser `localStorage` so the preview works without a backend.
- Production persistence should be connected to Supabase tables/RLS before handling real billing data. Recommended tables: `profiles (id, role)`, `products`, `invoices`, and `invoice_items`.

## User guide
1. Log in or create an account. In preview mode, select a role on the signup form.
2. Owners and Employees open **POS billing**, start the camera, or enter a barcode/SKU manually.
3. Search results and scans immediately add products to the cart; repeated scans increment quantity.
4. Review GST and totals, then select **Create invoice**.
5. Open the generated invoice from **Invoices** and copy its shareable link.
6. Customers can open an invoice link directly without being trapped on the login screen.

## Development and verification
```bash
npm install
npm run dev
npm run lint
npm run build
npm run preview
```

Vite preview hosts are configured with `server.allowedHosts: true` for GenSpark sandbox hostnames.

## Deployment
- **Stack:** React 19, Vite 8, React Router, Tailwind CSS 4 tooling, Supabase JS.
- **Target:** Netlify via GitHub automatic deployment (`netlify.toml` publishes `dist` and rewrites SPA routes).
- **Status:** Build and lint verified locally; production deployment requires the connected Netlify/GitHub pipeline and environment variables.
- **Repository:** `https://github.com/shopbilling07-ship-it/shopbilling.git`
