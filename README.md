# BillFlow

BillFlow is a React + Vite POS and GST billing workspace for small shops, with Supabase-backed authentication, workspace-scoped inventory, barcode scanning, billing, and receipts.

## Completed features
- Supabase Auth login/signup, profile lookup, role-aware navigation, and demo mode when credentials are unavailable.
- Workspace-scoped product and invoice loading with product CRUD and checkout stock deduction.
- Universal USB/Bluetooth barcode-gun listener in `src/hooks/useBarcodeScanner.ts`: rapid keypresses under 30ms terminated by Enter are handled as scans.
- POS barcode lookup by barcode/SKU, cart quantity increments, success beep using Web Audio API, and `Product not found` feedback.
- Reusable `html5-qrcode` camera modal with HTTPS, permission, missing-camera, start, stop, and manual/hardware fallback messaging.
- Inventory fields for Product Name, SKU, Barcode, Price, Cost Price, Stock Quantity, Min Stock Alert, and GST Rate (%).
- Inventory scan autofill, duplicate barcode detection, random barcode generation, low-stock badges, and JsBarcode label printing.
- POS manual search, low-stock warnings based on `min_stock_alert`, GST/subtotal/total calculations, and 80mm thermal receipt printing.
- UPI/Cash/Card checkout, public digital receipt routes, copy/share actions, WhatsApp sharing, dark/light mode, responsive layout, and SPA deployment configuration.

## Entry routes
- `/` — Owner dashboard and recent invoices.
- `/pos` — Owner/Employee billing counter with manual, camera, and USB/Bluetooth barcode scanning.
- `/inventory` — Owner/Employee product and barcode manager.
- `/invoices` — Signed-in invoice list.
- `/invoice/:id` and `/receipt/:id` — Digital receipt routes.
- `/customers`, `/reports`, `/settings` — Owner-only portals.

## Barcode workflow
1. Open `/pos` or `/inventory` and keep the page active.
2. Scan with a USB/Bluetooth barcode gun. The gun must send rapid characters followed by Enter.
3. POS looks up the barcode, adds/increments the cart item, and plays a short beep. Unknown codes show `Product not found`.
4. Inventory fills the Barcode field and reports whether another product already uses the code.
5. For camera devices, choose **Open camera**, grant permission, and point the camera at the barcode. Manual entry remains available when HTTPS or camera access is unavailable.
6. Generate a barcode for a product without one, save it, then use **Print Barcode Label** to print a sticker.
7. After checkout, use **Print Receipt** for an 80mm thermal-printer layout.

## Environment and Supabase schema
Copy `.env.example` to `.env.local`:
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
Recommended tables and columns:
- `profiles(id uuid primary key references auth.users, full_name text, role text, workspace_id uuid)`
- `products(id, workspace_id, sku, barcode, name, price, cost_price, tax or tax_rate, stock, min_stock_alert)`
- `invoices` with workspace, customer, totals, status, and payment method fields.
- `invoice_items` related to invoices and products.

Enable RLS and workspace policies appropriate to Owner/Employee/Customer roles before using production billing data. If using legacy `inventory_count` or `tax_rate` columns, update the product payload or migrate the schema consistently.

## Development
```bash
npm install
npm run dev
npm run lint
npm run build
npm run preview
```

## Deployment
- **Stack:** React 19, Vite 8, React Router, Supabase JS, `html5-qrcode`, `jsbarcode`, Recharts, and react-hot-toast.
- **Target:** Netlify or Vercel through the connected GitHub repository. `netlify.toml` and `vercel.json` provide SPA fallbacks.
- **Repository:** https://github.com/premnagtilak7-droid/shopbillingnew.git
- **Status:** Barcode, camera, inventory, POS, and thermal receipt workflow implemented; run lint/build before deployment.
