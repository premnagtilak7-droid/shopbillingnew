/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createClient } from '@supabase/supabase-js'
import { QRCodeSVG } from 'qrcode.react'
import { Html5Qrcode } from 'html5-qrcode'
import JsBarcode from 'jsbarcode'
import ErrorBoundary from './components/ErrorBoundary'
import { useBarcodeScanner, playBarcodeBeep } from './hooks/useBarcodeScanner'
import { CartesianGrid, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts'
import toast, { Toaster } from 'react-hot-toast'
import './styles.css'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
const supabase = supabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null

async function getProfile(userId) {
  if (!supabase || !userId) return null
  const { data, error } = await supabase.from('profiles').select('full_name, role, workspace_id').eq('id', userId).maybeSingle()
  if (error) console.warn('Profile lookup failed:', error.message)
  return data
}

async function findProduct(key) {
  const normalized = String(key || '').trim()
  if (!normalized) return null
  if (supabase) {
    const { data, error } = await supabase.from('products').select('*').or(`barcode.eq.${normalized},sku.eq.${normalized}`).maybeSingle()
    if (!error && data) return { ...data, price: Number(data.price), cost_price: Number(data.cost_price ?? data.costPrice ?? 0), tax: Number(data.tax ?? data.tax_rate ?? 0), tax_rate: Number(data.tax_rate ?? data.tax ?? 0), stock: Number(data.stock ?? data.inventory_count ?? 0), reorder_level: Number(data.reorder_level ?? data.reorderLevel ?? 5) }
    if (error) console.warn('Product lookup failed:', error.message)
  }
  return products.find(item => item.barcode === normalized || item.sku.toLowerCase() === normalized.toLowerCase()) || null
}

function isMissingProductColumn(error) {
  return /schema cache|column .* does not exist|could not find the .* column/i.test(error?.message || '')
}

function missingColumnName(error) {
  const match = String(error?.message || '').match(/(?:the\s+)?['"]([^'"]+)['"]\s+column/i)
  return match?.[1] || null
}

async function insertProductWithSchemaFallback(payload) {
  let candidate = { ...payload }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await supabase.from('products').insert(candidate).select('*').single()
    if (!result.error) return result
    const column = missingColumnName(result.error)
    if (!isMissingProductColumn(result.error) || !column || !(column in candidate)) return result
    delete candidate[column]
  }
  return { data: null, error: new Error('The products table has too many unsupported columns. Check its schema.') }
}

async function updateProductWithSchemaFallback(product, target, id, workspaceId) {
  let candidate = { ...product }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let query = supabase.from('products').update(candidate).eq(target?.id ? 'id' : 'sku', id)
    if (workspaceId) query = query.eq('workspace_id', workspaceId)
    const result = await query.select('*').single()
    if (!result.error) return result
    const column = missingColumnName(result.error)
    if (!isMissingProductColumn(result.error) || !column || !(column in candidate)) return result
    delete candidate[column]
  }
  return { data: null, error: new Error('The products table has too many unsupported columns. Check its schema.') }
}

async function loadProducts(workspaceId) {
  if (!supabase) return products
  let query = supabase.from('products').select('*').order('name')
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query
  if (error) { toast.error(`Failed to load inventory: ${error.message}`); return [] }
  return (data || []).map(item => ({ ...item, price: Number(item.price), cost_price: Number(item.cost_price ?? item.costPrice ?? 0), tax: Number(item.tax ?? item.tax_rate ?? 0), stock: item.stock == null && item.inventory_count == null ? null : Number(item.stock ?? item.inventory_count), min_stock_alert: Number(item.min_stock_alert ?? item.minStockAlert ?? 10), reorder_level: Number(item.reorder_level ?? item.reorderLevel ?? 5) }))
}

async function decrementStock(items, workspaceId) {
  if (!supabase) return { ok: true, updates: items.map(item => ({ id: item.id, sku: item.sku, stock: item.stock == null ? null : Math.max(0, Number(item.stock) - Number(item.quantity)) })) }

  const updates = []
  for (const item of items) {
    const quantity = Number(item.quantity || 0)
    if (!quantity) continue
    if (item.stock != null && Number(item.stock) < quantity) {
      toast.error(`Insufficient stock for ${item.name}`)
      return { ok: false }
    }

    if (item.id) {
      const { error: rpcError } = await supabase.rpc('decrement_stock', { product_id: item.id, quantity_sold: quantity })
      if (!rpcError) {
        updates.push({ id: item.id, sku: item.sku, stock: item.stock == null ? null : Math.max(0, Number(item.stock) - quantity) })
        continue
      }
      if (/insufficient|stock/i.test(rpcError.message || '')) {
        toast.error(`Insufficient stock for ${item.name}`)
        return { ok: false }
      }
    }

    const nextStock = item.stock == null ? null : Number(item.stock) - quantity
    if (nextStock != null && nextStock < 0) {
      toast.error(`Insufficient stock for ${item.name}`)
      return { ok: false }
    }
    if (nextStock == null) {
      updates.push({ id: item.id, sku: item.sku, stock: null })
      continue
    }

    let updateQuery = supabase.from('products').update({ stock: nextStock }).eq(item.id ? 'id' : 'sku', item.id || item.sku)
    if (workspaceId) updateQuery = updateQuery.eq('workspace_id', workspaceId)
    const { data, error } = await updateQuery.select('id, sku, stock').maybeSingle()
    if (error || !data) {
      toast.error(error?.message || `Failed to update inventory for ${item.name}`)
      return { ok: false }
    }
    updates.push({ id: data.id, sku: data.sku || item.sku, stock: Number(data.stock) })
  }
  return { ok: true, updates }
}

async function loadInvoices(workspaceId) {
  if (!supabase) return seedInvoices
  let query = supabase.from('invoices').select('*, invoice_items(*)').order('created_at', { ascending: false })
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query
  if (error) { console.warn('Invoice loading failed:', error.message); return [] }
  if (!data?.length) return []
  return data.map(row => ({ id: row.invoice_number || row.id, customer: row.customer_name || row.customer || 'Customer', date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—', items: row.invoice_items || row.items || [], subtotal: Number(row.subtotal || 0), tax: Number(row.tax || row.tax_amount || 0), total: Number(row.total || row.total_amount || 0), status: row.status || 'Pending', payment: row.payment_method || row.payment || 'Pending' }))
}

const products = [
  { sku: 'RICE-5KG', barcode: '8901234567890', name: 'Premium Rice 5kg', price: 460, tax: 5, stock: 24 },
  { sku: 'OIL-1L', barcode: '8901234567891', name: 'Sunflower Oil 1L', price: 165, tax: 5, stock: 7 },
  { sku: 'SOAP-3PK', barcode: '8901234567892', name: 'Bath Soap 3 Pack', price: 120, tax: 18, stock: 42 },
  { sku: 'TEA-250G', barcode: '8901234567893', name: 'Assam Tea 250g', price: 185, tax: 5, stock: 5 },
]
const seedInvoices = [
  { id: 'INV-1048', customer: 'Aarav Mehta', date: '02 Sep 2026', items: [{ ...products[0], quantity: 2 }], status: 'Paid', payment: 'UPI' },
  { id: 'INV-1047', customer: 'Priya Shah', date: '01 Sep 2026', items: [{ ...products[2], quantity: 2 }], status: 'Pending', payment: 'Cash' },
]
const money = value => `₹${Math.round(Number(value || 0)).toLocaleString('en-IN')}`
const normalizeScannedProduct = product => ({
  ...product,
  price: Number(product?.price || 0),
  cost_price: Number(product?.cost_price || 0),
  tax_rate: Number(product?.tax_rate ?? product?.tax ?? 0),
  tax: Number(product?.tax ?? product?.tax_rate ?? 0),
  stock: Number(product?.stock || 0),
  barcode: String(product?.barcode || ''),
  name: String(product?.name || 'Unnamed Item'),
  sku: String(product?.sku || product?.barcode || product?.name || 'ITEM')
})
const initials = name => name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()
const getDemoUser = () => {
  try { return JSON.parse(localStorage.getItem('billflow-user')) || null } catch { return null }
}

function printBarcodeLabel(product) {
  if (!product?.barcode) return toast.error('Add a barcode before printing a label')
  const popup = window.open('', '_blank', 'width=420,height=320')
  if (!popup) return toast.error('Allow pop-ups to print barcode labels')
  popup.document.write('<!doctype html><html><head><title>Barcode label</title><style>body{font-family:Arial;text-align:center;padding:20px}h3{margin:0 0 10px;font-size:14px}svg{max-width:100%}@media print{body{padding:4px}}</style></head><body><h3></h3><svg id="barcode"></svg></body></html>')
  popup.document.close()
  popup.document.querySelector('h3').textContent = product.name
  JsBarcode(popup.document.querySelector('#barcode'), product.barcode, { format: 'auto', displayValue: true, margin: 8, height: 55 })
  popup.focus()
  popup.print()
  popup.close()
}

function printThermalReceipt({ items, subtotal, tax, total }) {
  const popup = window.open('', '_blank', 'width=360,height=640')
  if (!popup) return toast.error('Allow pop-ups to print the receipt')
  const lines = items.map(item => `<div class="line"><span>${item.name}<small>${item.quantity} x ${money(item.price)}</small></span><b>${money(item.price * item.quantity)}</b></div>`).join('')
  popup.document.write(`<!doctype html><html><head><title>BillFlow receipt</title><style>@page{size:80mm auto;margin:0}body{width:72mm;margin:0 auto;padding:5mm 3mm;font:12px monospace;color:#111}.head{text-align:center;border-bottom:1px dashed #111;padding-bottom:8px;margin-bottom:8px}.head h2{font-size:18px;margin:0 0 4px}.line{display:flex;justify-content:space-between;gap:8px;margin:7px 0}.line span{max-width:48%}.line small{display:block;margin-top:2px}.totals{border-top:1px dashed #111;margin-top:10px;padding-top:8px}.total{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;margin-top:6px}@media print{button{display:none}}</style></head><body><div class="head"><h2>BillFlow</h2><div>Thermal Receipt</div><div>${new Date().toLocaleString('en-IN')}</div></div>${lines}<div class="totals"><div>Subtotal: ${money(subtotal)}</div><div>GST: ${money(tax)}</div><div class="total"><span>Total</span><span>${money(total)}</span></div></div><p style="text-align:center;margin-top:18px">Thank you for shopping!</p></body></html>`)
  popup.document.close()
  popup.focus()
  popup.print()
  popup.close()
}

function Icon({ name, size = 19 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    invoice: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    chart: <><path d="M3 3v18h18"/><path d="m7 16 4-5 3 3 6-8"/></>, settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.41 1.41-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-2v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.41-1.41.06-.06A1.7 1.7 0 0 0 9.4 15a1.7 1.7 0 0 0-1.56-1.03H7v-2h.84A1.7 1.7 0 0 0 9.4 11a1.7 1.7 0 0 0-.34-1.88L9 9.06l1.41-1.41.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.38 6.5V6h2v.5A1.7 1.7 0 0 0 16.4 8a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.41 1.41-.06.06A1.7 1.7 0 0 0 19.4 11a1.7 1.7 0 0 0 1.56 1.03H21v2h-.04A1.7 1.7 0 0 0 19.4 15Z"/></>, plus: <><path d="M12 5v14M5 12h14"/></>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, camera: <><path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3"/></>, close: <><path d="m6 6 12 12M18 6 6 18"/></>, arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>, check: <path d="m5 12 4 4L19 6"/>, download: <><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></>, more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function Auth({ onAuth }) {
  const [mode, setMode] = useState('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [fullName, setFullName] = useState(''); const [role, setRole] = useState('Owner'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async event => { event.preventDefault(); setError(''); if (!email.includes('@') || password.length < 6) return setError('Enter a valid email and a password of at least 6 characters.'); setBusy(true)
    try { if (supabase) { let result; if (mode === 'login') { result = await supabase.auth.signInWithPassword({ email, password }) } else { result = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName || email.split('@')[0], role } } }); if (result.error && /already registered|user already exists/i.test(result.error.message)) result = await supabase.auth.signInWithPassword({ email, password }) } if (result.error) throw result.error; if (mode === 'signup' && !result.data.session) { setError('Account created. Check your email to confirm, then sign in.'); setMode('login'); return } if (!result.data.user) throw new Error('Unable to start your session.'); const profile = await getProfile(result.data.user.id); onAuth({ id: result.data.user.id, email: result.data.user.email, name: profile?.full_name || result.data.user.user_metadata?.full_name || email.split('@')[0], role: profile?.role || result.data.user.user_metadata?.role || role }) } else { onAuth({ email, name: fullName || email.split('@')[0], role }) } } catch (err) { setError(err.message || 'Authentication failed. Please try again.') } finally { setBusy(false) }
  }
  return <main className="auth-shell"><section className="auth-card"><div className="brand auth-brand"><div className="brand-mark">B</div><span>Bill<span>Flow</span></span></div><h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1><p className="muted">{supabaseConfigured ? 'Securely sign in with Supabase Auth.' : 'Preview mode is active. Add Supabase keys for production authentication.'}</p>{!supabaseConfigured && <div className="notice">Supabase is not configured. Demo sessions are kept in this browser only.</div>}<div className="auth-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError('') }}>Login</button><button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError('') }}>Sign up</button></div><form onSubmit={submit}>{mode === 'signup' && <label>Full name<input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="Your name" required /></label>}<label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@shop.com" autoComplete="email" required /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 6 characters" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>{mode === 'signup' && <label>Workspace role<select value={role} onChange={event => setRole(event.target.value)}><option>Owner</option><option>Employee</option><option>Customer</option></select></label>}{error && <p className="form-error">{error}</p>}<button className="primary-btn full" disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Login to BillFlow' : 'Create account'}</button></form></section></main>
}

function Layout({ user, onLogout, onToggleTheme, darkMode, children }) { const [menuOpen, setMenuOpen] = useState(false); const location = useLocation(); const title = location.pathname === '/' ? 'Overview' : location.pathname.slice(1).split('/')[0].replace(/\b\w/g, x => x.toUpperCase()); const links = [{ path: '/', label: 'Overview', icon: 'grid', roles: ['Owner'] }, { path: '/pos', label: 'POS billing', icon: 'invoice', roles: ['Owner', 'Employee'] }, { path: '/inventory', label: 'Inventory', icon: 'barcode', roles: ['Owner', 'Employee'] }, { path: '/invoices', label: 'Invoices', icon: 'invoice', roles: ['Owner', 'Employee', 'Customer'] }, { path: '/customers', label: 'Customers', icon: 'users', roles: ['Owner'] }, { path: '/reports', label: 'Reports', icon: 'chart', roles: ['Owner'] }]; return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">B</div><span>Bill<span>Flow</span></span></div><div className="workspace-label">WORKSPACE</div><nav className="main-nav">{links.filter(link => link.roles.includes(user.role)).map(link => <NavLink end={link.path === '/'} key={link.path} to={link.path} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon name={link.icon}/><span>{link.label}</span></NavLink>)}</nav><div className="workspace-label second">MANAGE</div>{user.role === 'Owner' && <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon name="settings"/><span>Settings</span></NavLink>}<div className="sidebar-bottom"><div className="user-mini"><div className="avatar purple">{initials(user.name)}</div><div><strong>{user.name}</strong><small>{user.role} account</small></div><button type="button" aria-label="Open account menu" aria-expanded={menuOpen} className="account-menu-trigger" onClick={() => setMenuOpen(value => !value)}><Icon name="more" size={18}/></button>{menuOpen && <div className="account-popover" role="menu"><button type="button" role="menuitem" onClick={() => setMenuOpen(false)}>View Profile</button><NavLink role="menuitem" to="/settings" onClick={() => setMenuOpen(false)}>Workspace Settings</NavLink><button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onLogout() }}>Sign Out</button></div>}</div></div></aside><section className="main-area"><header className="topbar"><div><div className="breadcrumb">Workspace <span>/</span> {title}</div><h1>{title}</h1></div><div className="top-actions"><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">{darkMode ? 'Light' : 'Dark'} mode</button><span className="role-badge">{user.role}</span><div className="top-avatar">{initials(user.name)}</div></div></header><main className="content">{children}</main></section></div> }

function Protected({ user, roles, children }) { return roles.includes(user.role) ? children : <Navigate to="/invoices" replace /> }
function ProductSearch({ onAdd, products: catalog }) { const [query, setQuery] = useState(''); const matches = catalog.filter(item => `${item.name} ${item.sku} ${item.barcode}`.toLowerCase().includes(query.toLowerCase())); return <section className="panel product-search"><div className="search-box"><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search product, SKU or barcode…" /></div><div className="product-results">{matches.map(item => <button key={item.sku} onClick={() => onAdd(item)}><span><strong>{item.name}</strong><small>{item.sku} · {item.barcode}</small></span><b>{money(item.price)}</b></button>)}</div></section> }
function CameraScannerModal({ onCode, onClose }) {
  const scannerRef = useRef(null)
  const [message, setMessage] = useState('Requesting camera permission…')
  const scannerId = 'billflow-camera-modal-reader'

  useEffect(() => {
    let mounted = true
    const start = async () => {
      if (!window.isSecureContext && location.hostname !== 'localhost') {
        setMessage('Camera access requires HTTPS. Use a hardware scanner or manual entry.')
        return
      }
      try {
        const scanner = new Html5Qrcode(scannerId)
        scannerRef.current = scanner
        await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 140 }, aspectRatio: 1.777 }, decoded => onCode(decoded), () => {})
        if (mounted) setMessage('Scanning continuously — point at a barcode')
      } catch (error) {
        if (mounted) setMessage(error?.message?.toLowerCase().includes('permission') ? 'Camera permission was denied. Enable it in browser settings.' : 'Camera could not start. Check camera access and HTTPS, then use manual entry.')
        scannerRef.current = null
      }
    }
    start()
    return () => {
      mounted = false
      const scanner = scannerRef.current
      scannerRef.current = null
      if (scanner) {
        ;(async () => {
          try { await scanner.stop() } catch (error) { console.warn('Camera stop failed:', error) }
          try { await scanner.clear() } catch (error) { console.warn('Camera cleanup failed:', error) }
        })()
      }
    }
  }, [onCode])

  return <div className="modal-backdrop"><section className="modal camera-modal"><div className="modal-head"><div><p className="eyebrow">CAMERA SCANNER</p><h3>Scan barcode</h3></div><button className="close-btn" onClick={onClose}><Icon name="close"/></button></div><div className="camera-box is-scanning"><div id={scannerId} className="camera-reader"/><div className="scanner-frame" aria-hidden="true"><i/><i/><i/><i/></div></div><small className="muted">{message}</small></section></div>
}

function Scanner({ onCode }) {
  const [open, setOpen] = useState(false)
  return <section className="scanner panel"><div className="panel-heading"><div><h3>Barcode scanner</h3><p className="muted">Use your device camera as a fallback</p></div><button className="secondary-btn" onClick={() => setOpen(true)}><Icon name="camera" size={16}/> Open camera</button></div>{open && <CameraScannerModal onCode={onCode} onClose={() => setOpen(false)}/>}<div className="camera-placeholder compact-placeholder"><Icon name="camera" size={26}/><span>USB/Bluetooth scanner and manual entry are also supported.</span></div></section>
}

function Cart({ cart, setCart, onCheckout }) { const subtotal = cart.reduce((sum, item) => sum + Number(item?.price || 0) * Number(item?.quantity || 0), 0); const tax = cart.reduce((sum, item) => sum + Number(item?.price || 0) * Number(item?.quantity || 0) * Number(item?.tax_rate ?? item?.tax ?? 0) / 100, 0); const total = subtotal + tax; const change = (sku, amount) => setCart(items => items.map(item => item.sku === sku ? { ...item, quantity: Math.max(0, Number(item.quantity || 0) + amount) } : item).filter(item => item.quantity)); return <section className="panel cart-panel"><div className="panel-heading"><div><h3>Current cart</h3><p className="muted">{cart.reduce((sum, item) => sum + Number(item?.quantity || 0), 0)} items</p></div><button className="text-btn" onClick={() => setCart([])}>Clear</button></div>{cart.length === 0 ? <div className="empty-friendly compact"><Icon name="invoice" size={28}/><p>Scan or search products to begin.</p></div> : <div className="cart-lines">{cart.map(item => <div className="cart-line" key={item.sku}><div><strong>{item.name || 'Unnamed Item'}</strong><small>{item.sku || '—'} · {money(item.price)} + {Number(item.tax_rate ?? item.tax ?? 0)}% GST</small></div><div className="quantity"><button onClick={() => change(item.sku, -1)}>−</button><b>{item.quantity || 0}</b><button onClick={() => change(item.sku, 1)}>+</button></div><strong>{money(Number(item?.price || 0) * Number(item?.quantity || 0))}</strong></div>)}</div>}<div className="totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>GST</span><b>{money(tax)}</b></div><div className="grand-total"><span>Total</span><strong>{money(total)}</strong></div></div><button className="primary-btn full" disabled={!cart.length} onClick={() => onCheckout({ subtotal, tax, total })}>Create invoice</button></section> }

function POS({ onInvoice, catalog }) {
  const [cart, setCart] = useState([])
  const [manual, setManual] = useState('')
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [checkoutSummary, setCheckoutSummary] = useState(null)
  const [receiptData, setReceiptData] = useState(null)
  const add = product => {
    const safeProduct = normalizeScannedProduct(product)
    setCart(items => items.some(item => item.sku === safeProduct.sku)
      ? items.map(item => item.sku === safeProduct.sku ? { ...item, ...safeProduct, quantity: Number(item.quantity || 0) + 1 } : item)
      : [...items, { ...safeProduct, quantity: 1 }])
    setManual('')
    try { navigator.vibrate?.(60) } catch (error) { console.warn('Vibration unavailable:', error) }
    toast.success(`${safeProduct.name} added`)
  }

  const code = async value => {
    const normalized = String(value || '').trim()
    if (!normalized) return
    let product
    try {
      product = await findProduct(normalized)
    } catch (error) {
      console.error('Barcode product lookup failed:', error)
      toast.error('Unable to look up product')
      return
    }
    if (product) {
      try { playBarcodeBeep() } catch (error) { console.warn('Barcode beep unavailable:', error) }
      add(normalizeScannedProduct(product))
    } else {
      toast.error('Product not found')
    }
  }

  useBarcodeScanner(code, true)

  const checkout = summary => { setCheckoutSummary(summary); setPaymentOpen(true) }
  const complete = async payment => {
    const saved = await onInvoice({ customer: 'Walk-in customer', items: cart, ...checkoutSummary, payment, status: 'Paid' })
    if (!saved) return
    setReceiptData({ items: cart, ...checkoutSummary })
    setCart([])
    setPaymentOpen(false)
    toast.success('Payment recorded and receipt created')
  }

  const lowStockItems = cart.filter(item => item.stock != null && item.stock <= Number(item.min_stock_alert ?? 10))
  const printReceipt = () => {
    const printable = receiptData || (checkoutSummary && cart.length ? { items: cart, ...checkoutSummary } : null)
    if (!printable) return toast.error('Complete a bill before printing a receipt')
    printThermalReceipt(printable)
  }

  return <>
    <section className="page-intro"><div><p className="muted">Quick Billing Counter <span className="live-dot">● Live</span></p><small className="muted">USB/Bluetooth gun ready · scan a barcode ending with Enter</small></div><div className="low-stock-summary">{catalog.filter(item => item.stock != null && item.stock <= Number(item.min_stock_alert ?? 10)).length} low-stock alerts</div></section>
    <div className="pos-grid"><div><Scanner onCode={code}/><div className="panel manual-entry"><label>Manual barcode / SKU entry<div className="inline-form"><input value={manual} onChange={event => setManual(event.target.value)} onKeyDown={event => event.key === 'Enter' && code(manual)} placeholder="8901234567890 or RICE-5KG" autoFocus/><button className="primary-btn" onClick={() => code(manual)}>Add item</button></div></label></div><ProductSearch onAdd={add} products={catalog}/></div><div><Cart cart={cart} setCart={setCart} onCheckout={checkout}/>{lowStockItems.length > 0 && <div className="low-stock-warning"><strong>Low-stock warning</strong><span>{lowStockItems.map(item => `${item.name} (${item.stock} left)`).join(' · ')}</span></div>}{receiptData && <button className="secondary-btn print-receipt-btn" onClick={printReceipt}>Print Receipt</button>}</div></div>
    {paymentOpen && <PaymentModal total={checkoutSummary?.total || 0} onClose={() => setPaymentOpen(false)} onComplete={complete}/>} 
  </>
}

function PaymentModal({ total, onClose, onComplete }) { const [method, setMethod] = useState('UPI'); const upiLink = `upi://pay?pa=billflow@upi&pn=BillFlow&am=${total}&cu=INR`; return <div className="modal-backdrop"><section className="modal payment-modal"><div className="modal-head"><div><p className="eyebrow">SECURE CHECKOUT</p><h3>Collect {money(total)}</h3></div><button className="close-btn" onClick={onClose}><Icon name="close"/></button></div><div className="payment-methods">{['UPI', 'Cash', 'Card'].map(item => <button key={item} className={method === item ? 'selected' : ''} onClick={() => setMethod(item)}>{item}</button>)}</div>{method === 'UPI' && <div className="upi-panel"><div className="qr-placeholder">QR</div><p>Scan with any UPI app</p><a href={upiLink}>Open UPI payment</a></div>}<button className="primary-btn full" onClick={() => onComplete(method)}><Icon name="check" size={16}/> Mark {method} paid</button></section></div> }
function Inventory({ catalog, onCreate, onUpdate, onDelete, onAdjustStock }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const showReorderOnly = searchParams.get('filter') === 'reorder'
  const emptyForm = { name: '', sku: '', barcode: '', price: '', cost_price: '', stock: '', min_stock_alert: '10', reorder_level: '5', tax: '18' }
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [barcodeStatus, setBarcodeStatus] = useState('')
  const updateField = (field, value) => setForm(current => ({ ...current, [field]: value }))
  const checkBarcode = value => {
    const normalized = String(value || '').trim()
    if (!normalized) return setBarcodeStatus('')
    const existing = catalog.find(item => String(item.barcode || '').trim() === normalized && (item.id || item.sku) !== editingId)
    setBarcodeStatus(existing ? `Barcode already belongs to ${existing.name}` : 'Barcode is available')
  }
  const scanInventoryBarcode = value => {
    const normalized = String(value || '').trim()
    if (!normalized) return
    updateField('barcode', normalized)
    checkBarcode(normalized)
    playBarcodeBeep()
    toast.success('Barcode captured')
  }
  useBarcodeScanner(scanInventoryBarcode, true)
  const generateBarcode = () => {
    let barcode
    do barcode = `890${String(Math.floor(Math.random() * 10000000000)).padStart(10, '0')}`.slice(0, 13)
    while (catalog.some(item => item.barcode === barcode))
    updateField('barcode', barcode)
    checkBarcode(barcode)
  }
  const getStockStatus = item => {
    const stock = item.stock == null ? null : Number(item.stock)
    const reorderLevel = Number(item.reorder_level ?? item.reorderLevel ?? 5)
    if (stock === 0) return { label: 'Out of Stock', className: 'stock-status out-of-stock' }
    if (stock != null && stock <= reorderLevel) return { label: 'Low Stock', className: 'stock-status low-stock' }
    return { label: 'In Stock', className: 'stock-status in-stock' }
  }
  const lowStockItems = catalog.filter(item => item.stock != null && Number(item.stock) <= Number(item.reorder_level ?? item.reorderLevel ?? 5))
  const visibleCatalog = showReorderOnly ? lowStockItems : catalog
  const setReorderFilter = enabled => {
    if (enabled) setSearchParams({ filter: 'reorder' })
    else setSearchParams({})
  }

  const submit = async event => {
    event.preventDefault()
    if (!form.name.trim() || !form.sku.trim() || form.price === '') {
      toast.error('Name, SKU, and price are required')
      return
    }
    setBusy(true)
    const product = { ...form, name: form.name.trim(), sku: form.sku.trim(), barcode: form.barcode.trim(), price: Number(form.price), cost_price: Number(form.cost_price || 0), tax: Number(form.tax || 0), stock: form.stock === '' ? null : Number(form.stock), min_stock_alert: Number(form.min_stock_alert || 0), reorder_level: Number(form.reorder_level || 5) }
    if (barcodeStatus.startsWith('Barcode already')) {
      setBusy(false)
      toast.error(barcodeStatus)
      return
    }
    const saved = editingId ? await onUpdate(editingId, product) : await onCreate(product)
    setBusy(false)
    if (saved) {
      setForm(emptyForm)
      setEditingId(null)
      setBarcodeStatus('')
    }
  }

  const edit = item => {
    setEditingId(item.id || item.sku)
    setBarcodeStatus('')
    setForm({ name: item.name || '', sku: item.sku || '', barcode: item.barcode || '', price: String(item.price ?? ''), cost_price: String(item.cost_price ?? item.costPrice ?? 0), tax: String(item.tax ?? 0), stock: item.stock == null ? '' : String(item.stock), min_stock_alert: String(item.min_stock_alert ?? 10), reorder_level: String(item.reorder_level ?? item.reorderLevel ?? 5) })
  }
  const cancelEdit = () => { setEditingId(null); setForm(emptyForm); setBarcodeStatus('') }

  return <>
    <section className="page-intro"><div><p className="muted">Inventory & Barcode Manager</p><small className="muted">Live product catalog from Supabase</small></div><button type="button" className={showReorderOnly ? 'secondary-btn selected-filter' : 'secondary-btn'} onClick={() => setReorderFilter(!showReorderOnly)}>Low Stock Alerts <b>{lowStockItems.length}</b></button></section>
    <section className="panel low-stock-alert-panel"><div className="alert-panel-head"><div><p className="eyebrow">REORDER MONITOR</p><h3>Low Stock Alerts</h3><p className="muted">Products at or below their reorder level.</p></div><button type="button" className={showReorderOnly ? 'text-btn' : 'secondary-btn'} onClick={() => setReorderFilter(!showReorderOnly)}>{showReorderOnly ? 'Show all products' : 'View reorder items'}</button></div>{lowStockItems.length ? <div className="alert-items">{lowStockItems.map(item => { const status = getStockStatus(item); return <div className="alert-item" key={item.id || item.sku}><span><strong>{item.name}</strong><small>{item.stock == null ? 'Untracked stock' : `${item.stock} units on hand`} · reorder at {Number(item.reorder_level ?? 5)}</small></span><span className={status.className}>{status.label}</span></div> })}</div> : <p className="alert-clear">All tracked products are above their reorder levels.</p>}</section>
    <section className="panel invoice-page-panel inventory-manager">
      <form className="inventory-form" onSubmit={submit}><h3>{editingId ? 'Edit product' : 'Add product'}</h3><div className="form-grid"><label>Product Name<input value={form.name} onChange={event => updateField('name', event.target.value)} placeholder="Premium Rice 5kg" required /></label><label>SKU<input value={form.sku} onChange={event => updateField('sku', event.target.value)} placeholder="RICE-5KG" required /></label><label>Barcode<div className="field-with-action"><input value={form.barcode} onChange={event => { updateField('barcode', event.target.value); checkBarcode(event.target.value) }} placeholder="Scan or enter barcode" /><button type="button" className="secondary-btn compact-btn" onClick={generateBarcode}>Generate Random Barcode</button></div>{barcodeStatus && <small className={barcodeStatus.startsWith('Barcode already') ? 'danger-text' : 'success-text'}>{barcodeStatus}</small>}</label><label>Price<input type="number" min="0" step="0.01" value={form.price} onChange={event => updateField('price', event.target.value)} required /></label><label>Cost Price<input type="number" min="0" step="0.01" value={form.cost_price} onChange={event => updateField('cost_price', event.target.value)} /></label><label>Stock Quantity<input type="number" min="0" step="1" value={form.stock} onChange={event => updateField('stock', event.target.value)} placeholder="Leave blank if untracked" /></label><label>Reorder Level<input type="number" min="0" step="1" value={form.reorder_level} onChange={event => updateField('reorder_level', event.target.value)} /></label><label>Min Stock Alert<input type="number" min="0" step="1" value={form.min_stock_alert} onChange={event => updateField('min_stock_alert', event.target.value)} /></label><label>GST Rate (%)<input type="number" min="0" step="0.01" value={form.tax} onChange={event => updateField('tax', event.target.value)} /></label></div><div className="form-actions"><button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Update product' : 'Add product'}</button>{editingId && <button type="button" className="secondary-btn" onClick={cancelEdit}>Cancel</button>}</div></form>
      <div className="product-results">{visibleCatalog.length ? visibleCatalog.map(item => { const status = getStockStatus(item); const itemId = item.id || item.sku; const stock = item.stock == null ? 0 : Number(item.stock); return <div className="inventory-row" key={itemId}><span><strong>{item.name}</strong><small>{item.sku} · {item.barcode || 'No barcode'} · {money(item.price)} · Cost {money(item.cost_price || 0)} · Reorder at {Number(item.reorder_level ?? 5)}</small></span><span className={status.className}>{item.stock == null ? 'Untracked stock' : `${status.label} · ${stock}`}</span><span className="stock-adjuster" aria-label={`Adjust stock for ${item.name}`}><button type="button" className="stock-adjust-btn" onClick={() => onAdjustStock(item, -1)} disabled={stock <= 0} aria-label={`Decrease ${item.name} stock`}>−</button><b>{item.stock == null ? '—' : stock}</b><button type="button" className="stock-adjust-btn" onClick={() => onAdjustStock(item, 1)} aria-label={`Increase ${item.name} stock`}>+</button></span><span className="inventory-actions"><button type="button" className="secondary-btn" onClick={() => printBarcodeLabel(item)} disabled={!item.barcode}>Print Barcode Label</button><button type="button" className="secondary-btn" onClick={() => edit(item)}>Edit</button><button type="button" className="text-btn danger-text" onClick={() => onDelete(itemId)}>Delete</button></span></div> }) : <div className="empty-friendly compact"><p>{showReorderOnly ? 'No products currently need reordering.' : 'No products found in this workspace.'}</p></div>}</div>
    </section>
  </>
}
function InvoiceTable({ invoices }) { const navigate = useNavigate(); return <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>{invoices.map(item => <tr key={item.id}><td><strong className="invoice-id">{item.id}</strong></td><td>{item.customer}</td><td className="muted">{item.date}</td><td><strong>{money(item.total || item.items?.reduce((sum, x) => sum + x.price * x.quantity * (1 + x.tax / 100), 0) || 0)}</strong></td><td><span className={`status ${item.status.toLowerCase()}`}><i/>{item.status}</span></td><td><button className="more-btn" onClick={() => navigate(`/invoice/${item.id}`)}><Icon name="arrow" size={16}/></button></td></tr>)}</tbody></table></div> }
function Invoices({ invoices }) { const [query, setQuery] = useState(''); const filtered = invoices.filter(item => `${item.id} ${item.customer}`.toLowerCase().includes(query.toLowerCase())); return <><section className="page-intro"><p className="muted">Shareable digital invoices and customer payment status.</p></section><section className="panel invoice-page-panel"><div className="toolbar"><div className="search-box"><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search invoices or customers…"/></div></div><InvoiceTable invoices={filtered}/></section></> }
function InvoiceDetail({ invoices }) { const { id } = useParams(); const invoice = invoices.find(item => item.id === id); if (!invoice) return <section className="panel empty-friendly"><h3>Invoice not found</h3><p className="muted">This link may be expired or the invoice was removed.</p></section>; const subtotal = invoice.subtotal ?? invoice.items.reduce((sum, item) => sum + item.price * item.quantity, 0); const tax = invoice.tax ?? invoice.items.reduce((sum, item) => sum + item.price * item.quantity * item.tax / 100, 0); const total = invoice.total ?? subtotal + tax; return <section className="invoice-detail panel"><div className="receipt-head"><div><p className="eyebrow">DIGITAL INVOICE</p><h2>{invoice.id}</h2><p className="muted">{invoice.date} · BillFlow</p></div><span className={`status ${invoice.status.toLowerCase()}`}><i/>{invoice.status}</span></div><div className="receipt-customer"><span>Billed to</span><strong>{invoice.customer}</strong></div>{invoice.items.map(item => <div className="receipt-item" key={item.sku}><span>{item.name}<small>{item.quantity} × {money(item.price)}</small></span><strong>{money(item.price * item.quantity)}</strong></div>)}<div className="totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>GST</span><b>{money(tax)}</b></div><div className="grand-total"><span>Total paid</span><strong>{money(total)}</strong></div></div><div className="receipt-actions"><div className="share-box"><input readOnly value={`${window.location.origin}/receipt/${invoice.id}`} onFocus={event => event.target.select()}/><button className="secondary-btn" onClick={() => { navigator.clipboard?.writeText(window.location.href); toast.success('Receipt link copied') }}>Copy link</button></div><a className="whatsapp-btn" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`BillFlow receipt ${invoice.id}: ${money(total)} ${window.location.origin}/receipt/${invoice.id}`)}`}>Send on WhatsApp</a><div className="payment-qr"><QRCodeSVG value={`${window.location.origin}/receipt/${invoice.id}`} size={96}/><small>Scan to view receipt</small></div></div></section> }
// Kept as a visual reference for the original dashboard layout.
// eslint-disable-next-line no-unused-vars
function OverviewLegacy({ invoices }) { return <><section className="welcome-row"><div><p className="eyebrow">Tuesday, 2 September 2026</p><h2>Good morning, BillFlow <span>•</span></h2><p className="muted">Your billing workspace at a glance.</p></div><NavLink className="primary-btn" to="/pos"><Icon name="plus" size={17}/> New bill</NavLink></section><section className="stats-grid"><article className="stat-card"><div className="stat-icon blue"><Icon name="chart"/></div><div className="stat-copy"><span>Total revenue</span><strong>{money(invoices.reduce((sum, item) => sum + (item.total || 0), 248560))}</strong><small>12.8% <em>vs last month</em></small></div></article><article className="stat-card"><div className="stat-icon purple"><Icon name="invoice"/></div><div className="stat-copy"><span>Total invoices</span><strong>{invoices.length + 182}</strong><small>8.4% <em>vs last month</em></small></div></article><article className="stat-card"><div className="stat-icon peach"><Icon name="users"/></div><div className="stat-copy"><span>Active customers</span><strong>96</strong><small>5.2% <em>vs last month</em></small></div></article></section><section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent invoices</h3><p className="muted">Your latest billing activity</p></div><NavLink to="/invoices" className="view-all">View all <Icon name="arrow" size={15}/></NavLink></div><InvoiceTable invoices={invoices.slice(0, 5)}/></section></> }
function EmptyState({ title, text, action, to = '/pos', icon = 'invoice' }) { return <div className="empty-friendly"><div className="big-soft-icon peach"><Icon name={icon} size={30}/></div><h3>{title}</h3><p className="muted">{text}</p>{action && <NavLink to={to} className="primary-btn">{action}<Icon name="arrow" size={15}/></NavLink>}</div> }
function calculateProfitAnalytics(invoices, catalog) {
  const productById = new Map(catalog.filter(item => item?.id).map(item => [String(item.id), item]))
  const productByKey = new Map(catalog.flatMap(item => [[item?.sku, item], [item?.barcode, item], [item?.name, item]]).filter(([key]) => key))
  const sales = new Map()
  const validInvoices = invoices.filter(invoice => !/cancelled|void/i.test(invoice.status || ''))
  let revenue = 0
  let profit = 0

  validInvoices.forEach(invoice => {
    const invoiceItems = Array.isArray(invoice.items) ? invoice.items : []
    const invoiceSubtotal = Number(invoice.subtotal || 0)
    const calculatedSubtotal = invoiceItems.reduce((sum, item) => sum + Number(item?.unit_price ?? item?.price ?? 0) * Number(item?.quantity || 0), 0)
    revenue += invoiceSubtotal || calculatedSubtotal

    invoiceItems.forEach(item => {
      const product = productById.get(String(item?.product_id || '')) || productByKey.get(item?.sku) || productByKey.get(item?.barcode) || productByKey.get(item?.product_name) || item
      const quantity = Number(item?.quantity || 0)
      const sellingPrice = Number(item?.unit_price ?? item?.price ?? product?.price ?? 0)
      const costPrice = Number(item?.cost_price ?? product?.cost_price ?? 0)
      const itemRevenue = sellingPrice * quantity
      const itemProfit = (sellingPrice - costPrice) * quantity
      profit += itemProfit
      const key = String(product?.id || item?.product_id || product?.sku || item?.sku || item?.product_name || item?.name || 'Unknown product')
      const current = sales.get(key) || { name: product?.name || item?.product_name || item?.name || 'Unnamed Item', quantity: 0, revenue: 0, profit: 0 }
      current.quantity += quantity
      current.revenue += itemRevenue
      current.profit += itemProfit
      sales.set(key, current)
    })
  })

  const orderRevenue = validInvoices.reduce((sum, invoice) => sum + Number(invoice.total || invoice.subtotal || 0), 0)
  const aov = validInvoices.length ? orderRevenue / validInvoices.length : 0
  return {
    revenue,
    profit,
    margin: revenue ? (profit / revenue) * 100 : 0,
    aov,
    orderCount: validInvoices.length,
    topProducts: Array.from(sales.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 5)
  }
}

function Overview({ invoices, catalog }) {
  const analytics = calculateProfitAnalytics(invoices, catalog)
  const customerCount = new Set(invoices.map(item => item.customer).filter(Boolean)).size
  const lowStockItems = catalog.filter(item => item.stock != null && Number(item.stock) <= Number(item.reorder_level ?? item.reorderLevel ?? 5))
  return <>
    <section className="welcome-row"><div><p className="eyebrow">Today · workspace snapshot</p><h2>Good morning, BillFlow <span>•</span></h2><p className="muted">Live performance from your workspace.</p></div><NavLink className="primary-btn" to="/pos"><Icon name="plus" size={17}/> Create your first bill</NavLink></section>
    <section className="stats-grid analytics-stats"><article className="stat-card"><div className="stat-icon blue"><Icon name="chart"/></div><div className="stat-copy"><span>Total revenue</span><strong>{money(analytics.revenue)}</strong><small>From invoice line items</small></div></article><article className="stat-card"><div className="stat-icon green"><Icon name="chart"/></div><div className="stat-copy"><span>Total net profit</span><strong>{money(analytics.profit)}</strong><small>Selling price less cost price</small></div></article><article className="stat-card"><div className="stat-icon purple"><Icon name="chart"/></div><div className="stat-copy"><span>Gross margin</span><strong>{analytics.margin.toFixed(1)}%</strong><small>Profit ÷ revenue</small></div></article><article className="stat-card"><div className="stat-icon peach"><Icon name="invoice"/></div><div className="stat-copy"><span>Average order value</span><strong>{money(analytics.aov)}</strong><small>{analytics.orderCount} orders</small></div></article><article className="stat-card"><div className="stat-icon purple"><Icon name="invoice"/></div><div className="stat-copy"><span>Total invoices</span><strong>{invoices.length}</strong><small>Live from workspace</small></div></article><article className="stat-card"><div className="stat-icon peach"><Icon name="users"/></div><div className="stat-copy"><span>Active customers</span><strong>{customerCount}</strong><small>Unique billed customers</small></div></article></section>
    <section className="stock-attention-card"><div className="stock-attention-icon"><Icon name="invoice" size={21}/></div><div><p className="eyebrow">INVENTORY HEALTH</p><h3>Stock Attention Required</h3><p className="muted">{lowStockItems.length ? `${lowStockItems.length} product${lowStockItems.length === 1 ? '' : 's'} at or below the reorder level.` : 'All tracked products are above their reorder levels.'}</p></div><NavLink to="/inventory?filter=reorder" className="secondary-btn">Review inventory <Icon name="arrow" size={15}/></NavLink></section>
    <section className="panel top-products-panel"><div className="panel-heading"><div><h3>Top Best-Selling Items</h3><p className="muted">Ranked by quantity sold from invoices</p></div></div>{analytics.topProducts.length ? <div className="top-products-table"><div className="top-products-head"><span>Product</span><span>Qty sold</span><span>Revenue</span><span>Profit</span></div>{analytics.topProducts.map(item => <div className="top-product-row" key={item.name}><strong>{item.name}</strong><span>{item.quantity}</span><span>{money(item.revenue)}</span><b>{money(item.profit)}</b></div>)}</div> : <EmptyState title="No sales data yet" text="Create an invoice to see best-selling products and profit analytics." action="Open billing counter"/>}</section>
    <section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent invoices</h3><p className="muted">Your latest billing activity</p></div><NavLink to="/invoices" className="view-all">View all <Icon name="arrow" size={15}/></NavLink></div>{invoices.length ? <InvoiceTable invoices={invoices.slice(0, 5)}/> : <EmptyState title="Your dashboard is ready" text="Create your first bill to see revenue, customers, and invoice activity here." action="Open billing counter"/>}</section>
  </>
}
function Reports({ invoices }) { const sales = invoices.map((item, index) => ({ day: item.date || `Day ${index + 1}`, revenue: Number(item.total || 0), profit: Math.round(Number(item.total || 0) * .22) })); const payments = ['UPI', 'Cash', 'Card', 'Net Banking'].map(method => ({ name: method, value: invoices.filter(item => item.payment === method).reduce((sum, item) => sum + Number(item.total || 0), 0) })); const top = Object.values(invoices.flatMap(item => item.items || []).reduce((acc, item) => { acc[item.name] = acc[item.name] || { name: item.name, quantity: 0, revenue: 0 }; acc[item.name].quantity += Number(item.quantity || 0); acc[item.name].revenue += Number(item.price || 0) * Number(item.quantity || 0); return acc }, {})).sort((a, b) => b.revenue - a.revenue).slice(0, 5); return <><section className="page-intro"><div><p className="muted">Sales performance, GST collection, and product velocity.</p></div><button className="secondary-btn" onClick={() => window.print()}>Print report</button></section><section className="report-grid"><article className="panel report-chart"><div className="panel-heading"><div><h3>Revenue & profit</h3><p className="muted">Live from workspace invoices</p></div></div>{sales.length ? <ResponsiveContainer width="100%" height={260}><LineChart data={sales}><CartesianGrid strokeDasharray="3 3" stroke="#ececf3"/><XAxis dataKey="day"/><YAxis/><Tooltip formatter={value => money(value)}/><Line type="monotone" dataKey="revenue" stroke="#7569e8" strokeWidth={3}/><Line type="monotone" dataKey="profit" stroke="#25a876" strokeWidth={3}/></LineChart></ResponsiveContainer> : <EmptyState title="No sales yet" text="Create your first bill to unlock revenue trends." action="Open POS"/>}</article><article className="panel tax-card"><h3>Tax summary</h3><div className="report-number">{money(invoices.reduce((sum, item) => sum + Number(item.tax || 0), 0))}</div><p className="muted">Total GST collected</p><div className="summary-row"><span>Subtotal</span><b>{money(invoices.reduce((sum, item) => sum + Number(item.subtotal || 0), 0))}</b></div><div className="summary-row"><span>Invoices</span><b>{invoices.length}</b></div></article><article className="panel payment-card"><h3>Payment methods</h3>{invoices.length ? <ResponsiveContainer width="100%" height={220}><PieChart><Pie data={payments} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85}>{payments.map((item, index) => <Cell key={item.name} fill={['#7569e8','#f29b67','#25a876','#4d9de0'][index]}/>)}</Pie><Tooltip formatter={value => money(value)}/></PieChart></ResponsiveContainer> : <EmptyState title="No payments yet" text="Payment breakdown will appear after your first checkout."/>}</article><article className="panel top-products"><h3>Top-selling products</h3>{top.length ? top.map(item => <div className="summary-row" key={item.name}><span><strong>{item.name}</strong><small>{item.quantity} units</small></span><b>{money(item.revenue)}</b></div>) : <EmptyState title="No products sold" text="Your best sellers will appear here." action="Open POS"/>}</article></section></> }
function Settings() {
  const [saved, setSaved] = useState(false)
  const [tax, setTax] = useState('18%')
  const [prefix, setPrefix] = useState('INV-2026-')
  const [sequence, setSequence] = useState('001')
  const [size, setSize] = useState('3-inch')
  return <><section className="page-intro"><p className="muted">Store identity, billing preferences, and team access.</p></section><div className="settings-layout"><section className="panel settings-form"><h3>Store profile</h3><div className="form-grid"><label>Shop name<input defaultValue="BillFlow Store"/></label><label>GSTIN number<input placeholder="27AABCU9603R1ZM"/></label><label>Contact phone<input placeholder="+91 98765 43210"/></label><label>Invoice logo<input type="file" accept="image/*"/></label><label className="wide">Address<textarea placeholder="Store address"/></label></div><h3>Billing preferences</h3><div className="form-grid"><label>Default GST rate<select value={tax} onChange={event => setTax(event.target.value)}><option>0%</option><option>5%</option><option>12%</option><option>18%</option></select></label><label>Invoice prefix<input value={prefix} onChange={event => setPrefix(event.target.value)}/></label><label>Next sequence<input value={sequence} onChange={event => setSequence(event.target.value)}/></label><label>Thermal receipt size<select value={size} onChange={event => setSize(event.target.value)}><option>2-inch</option><option>3-inch</option></select></label></div><button className="primary-btn" onClick={() => { setSaved(true); toast.success('Workspace settings saved') }}>{saved ? 'Saved' : 'Save settings'}</button></section><section className="panel staff-panel"><h3>Staff & roles</h3><p className="muted">Owner-only access management.</p><div className="staff-row"><span><strong>Cashier access</strong><small>POS, scanning, checkout, receipts</small></span><span className="status paid"><i/>Active</span></div><div className="staff-row"><span><strong>Customer access</strong><small>View orders and digital receipts</small></span><span className="status pending"><i/>Invite</span></div><button className="secondary-btn" onClick={() => toast.success('Staff invitation form ready')}>Invite staff member</button></section></div></>
}
function SimplePage({ title, text, icon = 'users' }) { return <section className="panel empty-friendly"><div className="big-soft-icon peach"><Icon name={icon} size={30}/></div><h3>{title}</h3><p className="muted">{text}</p></section> }

function App() { const [user, setUser] = useState(() => supabase ? null : getDemoUser()); const [darkMode, setDarkMode] = useState(() => localStorage.getItem('billflow-theme') === 'dark'); const [catalog, setCatalog] = useState(() => supabase ? [] : products); const [invoices, setInvoices] = useState(() => { if (supabase) return []; try { return JSON.parse(localStorage.getItem('billflow-invoices')) || seedInvoices } catch { return seedInvoices } }); useEffect(() => { localStorage.setItem('billflow-invoices', JSON.stringify(invoices)) }, [invoices]); useEffect(() => { localStorage.setItem('billflow-theme', darkMode ? 'dark' : 'light'); document.body.dataset.theme = darkMode ? 'dark' : 'light' }, [darkMode]); useEffect(() => { let mounted = true; if (supabase) { supabase.auth.getSession().then(async ({ data }) => { if (!mounted || !data.session?.user) return; const profile = await getProfile(data.session.user.id); if (mounted) setUser({ id: data.session.user.id, email: data.session.user.email, name: profile?.full_name || data.session.user.user_metadata?.full_name || data.session.user.email?.split('@')[0], role: profile?.role || data.session.user.user_metadata?.role || 'Employee', workspace_id: profile?.workspace_id }) }); const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => { if (!session?.user) return setUser(null); const profile = await getProfile(session.user.id); if (mounted) setUser({ id: session.user.id, email: session.user.email, name: profile?.full_name || session.user.user_metadata?.full_name || session.user.email?.split('@')[0], role: profile?.role || session.user.user_metadata?.role || 'Employee', workspace_id: profile?.workspace_id }) }); return () => { mounted = false; listener.subscription.unsubscribe() } } return () => { mounted = false } }, []); useEffect(() => { if (!supabase || !user?.id) return; loadProducts(user.workspace_id).then(setCatalog); loadInvoices(user.workspace_id).then(setInvoices) }, [user?.id, user?.workspace_id]); const updateCatalogStocks = updates => setCatalog(current => current.map(item => {
    const update = updates.find(candidate => (candidate.id && candidate.id === item.id) || candidate.sku === item.sku)
    return update ? { ...item, stock: update.stock } : item
  }))
  const createProduct = async product => {
    if (!supabase) {
      const localProduct = { ...product, id: product.sku }
      setCatalog(current => [localProduct, ...current])
      toast.success('Product added to preview inventory')
      return true
    }
    const payload = { ...product, ...(user?.workspace_id ? { workspace_id: user.workspace_id } : {}) }
    const { data: created, error } = await insertProductWithSchemaFallback(payload)
    if (error) {
      toast.error(`Failed to add product: ${error.message}`)
      return false
    }
    const normalized = { ...product, ...created, price: Number(created.price), cost_price: Number(created.cost_price ?? product.cost_price ?? 0), tax: Number(created.tax ?? created.tax_rate ?? 0), stock: created.stock == null ? null : Number(created.stock), min_stock_alert: Number(created.min_stock_alert ?? product.min_stock_alert ?? 10), reorder_level: Number(created.reorder_level ?? product.reorder_level ?? 5) }
    setCatalog(current => [normalized, ...current])
    toast.success('Product added to inventory')
    return true
  }
  const updateProduct = async (id, product) => {
    if (!supabase) {
      setCatalog(current => current.map(item => (item.id || item.sku) === id ? { ...item, ...product, id: item.id || id } : item))
      toast.success('Product updated in preview inventory')
      return true
    }
    const target = catalog.find(item => (item.id || item.sku) === id)
    const { data: updated, error } = await updateProductWithSchemaFallback(product, target, id, user?.workspace_id)
    if (error) {
      toast.error(`Failed to update product: ${error.message}`)
      return false
    }
    const normalized = { ...product, ...updated, price: Number(updated.price), cost_price: Number(updated.cost_price ?? product.cost_price ?? 0), tax: Number(updated.tax ?? updated.tax_rate ?? 0), stock: updated.stock == null ? null : Number(updated.stock), min_stock_alert: Number(updated.min_stock_alert ?? product.min_stock_alert ?? 10), reorder_level: Number(updated.reorder_level ?? product.reorder_level ?? 5) }
    setCatalog(current => current.map(item => (item.id || item.sku) === id ? normalized : item))
    toast.success('Product updated')
    return true
  }
  const adjustStock = async (product, delta) => {
    const currentStock = product.stock == null ? 0 : Number(product.stock)
    const nextStock = Math.max(0, currentStock + Number(delta || 0))
    if (nextStock === currentStock) return false
    const productId = product.id || product.sku
    if (!supabase) {
      updateCatalogStocks([{ id: product.id, sku: product.sku, stock: nextStock }])
      toast.success(`${product.name} stock updated`)
      return true
    }
    let query = supabase.from('products').update({ stock: nextStock }).eq(product.id ? 'id' : 'sku', productId)
    if (user?.workspace_id) query = query.eq('workspace_id', user.workspace_id)
    const { data, error } = await query.select('id, sku, stock').maybeSingle()
    if (error || !data) {
      toast.error(error?.message || `Failed to update stock for ${product.name}`)
      return false
    }
    updateCatalogStocks([{ id: data.id, sku: data.sku || product.sku, stock: Number(data.stock) }])
    toast.success(`${product.name} stock updated`)
    return true
  }
  const deleteProduct = async id => {
    if (!window.confirm('Delete this product from inventory?')) return false
    if (!supabase) {
      setCatalog(current => current.filter(item => (item.id || item.sku) !== id))
      toast.success('Product deleted from preview inventory')
      return true
    }
    const target = catalog.find(item => (item.id || item.sku) === id)
    let query = supabase.from('products').delete().eq(target?.id ? 'id' : 'sku', id)
    if (user?.workspace_id) query = query.eq('workspace_id', user.workspace_id)
    const { error } = await query
    if (error) {
      toast.error(`Failed to delete product: ${error.message}`)
      return false
    }
    setCatalog(current => current.filter(item => (item.id || item.sku) !== id))
    toast.success('Product deleted')
    return true
  }
  const createInvoice = async data => {
    const stockResult = await decrementStock(data.items || [], user?.workspace_id)
    if (!stockResult.ok) return false
    const invoiceNumber = `INV-${1050 + invoices.length}`
    if (supabase) {
      const payload = { invoice_number: invoiceNumber, customer_name: data.customer, subtotal: data.subtotal, tax: data.tax, total: data.total, status: data.status, payment_method: data.payment, ...(user?.workspace_id ? { workspace_id: user.workspace_id } : {}) }
      const { data: created, error } = await supabase.from('invoices').insert(payload).select('*').single()
      if (error) {
        toast.error(`Failed to create invoice: ${error.message}`)
        return false
      }
      if (data.items?.length && created?.id) {
        const lines = data.items.map(item => ({ invoice_id: created.id, product_id: item.id || null, product_name: item.name, quantity: item.quantity, unit_price: item.price, tax_rate: item.tax, line_total: item.price * item.quantity * (1 + item.tax / 100) }))
        const { error: lineError } = await supabase.from('invoice_items').insert(lines)
        if (lineError) {
          toast.error(`Invoice created, but line items failed: ${lineError.message}`)
          return false
        }
      }
    }
    const invoice = { ...data, id: invoiceNumber, date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
    setInvoices(prev => [invoice, ...prev])
    updateCatalogStocks(stockResult.updates)
    toast.success('Invoice created — inventory updated')
    return true
  }
  return <BrowserRouter>{user ? <Layout user={user} darkMode={darkMode} onToggleTheme={() => setDarkMode(value => !value)} onLogout={async () => { await supabase?.auth.signOut(); localStorage.removeItem('billflow-user'); setUser(null) }}><Routes><Route path="/" element={<Protected user={user} roles={['Owner']}><Overview invoices={invoices} catalog={catalog}/></Protected>}/><Route path="/pos" element={<Protected user={user} roles={['Owner', 'Employee']}><ErrorBoundary><POS onInvoice={createInvoice} catalog={catalog}/></ErrorBoundary></Protected>}/><Route path="/invoices" element={<Invoices invoices={invoices}/>}/><Route path="/invoice/:id" element={<InvoiceDetail invoices={invoices}/>}/><Route path="/receipt/:id" element={<InvoiceDetail invoices={invoices}/>}/><Route path="/inventory" element={<Protected user={user} roles={['Owner', 'Employee']}><Inventory catalog={catalog} onCreate={createProduct} onUpdate={updateProduct} onDelete={deleteProduct} onAdjustStock={adjustStock}/></Protected>}/><Route path="/customers" element={<Protected user={user} roles={['Owner']}><SimplePage title="Customer management" text="Owner-only customer records and billing history."/></Protected>}/><Route path="/reports" element={<Protected user={user} roles={['Owner']}><Reports invoices={invoices}/></Protected>}/><Route path="/settings" element={<Protected user={user} roles={['Owner']}><Settings/></Protected>}/><Route path="*" element={<Navigate to="/invoices" replace/>}/></Routes></Layout> : <Routes><Route path="/invoice/:id" element={<InvoiceDetail invoices={invoices}/>}/><Route path="/receipt/:id" element={<InvoiceDetail invoices={invoices}/>}/><Route path="*" element={<Auth onAuth={nextUser => { localStorage.setItem('billflow-user', JSON.stringify(nextUser)); setUser(nextUser) }}/>}/></Routes>}<Toaster position="bottom-right"/></BrowserRouter> }

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>)
