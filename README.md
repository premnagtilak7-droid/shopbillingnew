# BillFlow

BillFlow is a modern React + Vite POS and GST billing workspace for small shops, with Supabase-backed authentication and product lookup when configured.

## Completed features
- Supabase Auth login/signup with `full_name` and `role` metadata, email-confirmation-safe handling, session restoration, auth state listener, and profile lookup from `public.profiles`.
- Explicit demo fallback when Supabase environment variables are unavailable.
- Supabase `public.products` lookup for barcode/SKU scanning and catalog loading, with seeded preview fallback.
- Continuous browser camera scanning using `BarcodeDetector`, manual SKU/barcode entry, instant feedback, duplicate quantity increments, GST/subtotal/total calculations, and cart controls.
- Owner, Employee, and Customer role-aware navigation and route guards.
- Owner overview, sales reporting, inventory/barcode manager, customer/settings areas; Employee quick billing counter; Customer invoice access.
- Low-stock alert counts and inventory badges.
- Quick UPI/Cash/Card checkout modal with UPI deep link and QR payment display.
- Public `/receipt/:id` and `/invoice/:id` receipt routes with itemized totals, payment status, QR viewing code, copy link, printable-friendly layout, and WhatsApp share link.
- Persisted preview invoices in localStorage, dark/light theme toggle, responsive desktop/tablet/mobile UI, and Netlify SPA rewrites.

## Entry routes
- `/` — Owner dashboard and recent invoices.
- `/pos` — Owner/Employee quick billing counter.
- `/inventory` — Owner/Employee inventory and barcode manager.
- `/invoices` — Signed-in invoice list.
- `/invoice/:id` and `/receipt/:id` — Public digital receipt routes.
- `/customers`, `/reports`, `/settings` — Owner-only portals.

## Environment and Supabase schema
Copy `.env.example` to `.env.local`:
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
Recommended Supabase tables and policies:
- `profiles(id uuid primary key references auth.users, full_name text, role text)`
- `products(id, sku, barcode, name, price, tax/tax_rate, stock/inventory_count)`
- `invoices` with `invoice_items` relation and fields for customer, totals, status, and payment method.
Enable RLS and policies appropriate to the Owner/Employee/Customer roles before handling production billing data.

## User guide
1. Configure Supabase keys for production, or use demo mode for preview testing.
2. Log in/sign up and select a role in demo mode.
3. Open POS billing, start the camera, or enter a barcode/SKU manually.
4. Review the cart, GST, and total. Choose Create invoice, then select UPI, Cash, or Card.
5. Copy the public receipt URL or send it through WhatsApp. Customers can open receipt links without being redirected to login.
6. Switch between light and dark mode from the top-bar control.

## Development
```bash
npm install
npm run dev
npm run lint
npm run build
npm run preview
```
Vite is configured with `server.allowedHosts: true` for GenSpark sandbox hostnames.

## Deployment
- **Stack:** React 19, Vite 8, React Router, Tailwind CSS tooling, Supabase JS.
- **Target:** Netlify through the connected GitHub repository. `netlify.toml` builds `dist` and rewrites client routes to `index.html`.
- **Status:** Lint and production build verified locally.
- **Repository:** https://github.com/shopbilling07-ship-it/shopbilling
