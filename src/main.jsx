/* eslint-disable react-refresh/only-export-components */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createClient } from '@supabase/supabase-js'
import { QRCodeSVG } from 'qrcode.react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import JsBarcode from 'jsbarcode'
import { jsPDF } from 'jspdf'
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
  const { data, error } = await supabase.from('profiles').select('id, full_name, role, workspace_id, can_apply_discounts, can_delete_cart_items, can_view_reports, can_edit_inventory, is_active, last_active_at').eq('id', userId).maybeSingle()
  if (error) console.warn('Profile lookup failed:', error.message)
  return data
}

const profilePermissions = profile => ({
  can_apply_discounts: profile?.role?.toLowerCase() === 'owner' || profile?.can_apply_discounts === true,
  can_delete_cart_items: profile?.role?.toLowerCase() === 'owner' || profile?.can_delete_cart_items === true,
  can_view_reports: profile?.role?.toLowerCase() === 'owner' || profile?.can_view_reports === true,
  can_edit_inventory: profile?.role?.toLowerCase() === 'owner' || profile?.can_edit_inventory === true
})

function mapAuthUser(authUser, profile, fallbackRole = 'Employee') {
  return {
    id: authUser?.id,
    email: authUser?.email,
    name: profile?.full_name || authUser?.user_metadata?.full_name || authUser?.email?.split('@')[0] || 'User',
    role: String(profile?.role || authUser?.user_metadata?.role || fallbackRole).replace(/^./, value => value.toUpperCase()),
    workspace_id: profile?.workspace_id,
    permissions: profilePermissions(profile),
    is_active: profile?.is_active !== false,
    last_active_at: profile?.last_active_at || null
  }
}

const defaultBranding = {
  store_name: 'BillFlow Store',
  tagline: 'Simple billing for growing shops',
  address: '',
  contact_phone: '',
  contact_email: '',
  tax_id: '',
  upi_id: '',
  logo_url: '',
  footer_note: 'Thank you for shopping with us! No refunds without receipt.'
}

const normalizeBranding = value => ({ ...defaultBranding, ...(value || {}) })

async function loadWorkspaceBranding(workspaceId) {
  if (!supabase || !workspaceId) return defaultBranding
  const { data, error } = await supabase.from('workspace_settings').select('store_name, tagline, address, contact_phone, contact_email, tax_id, upi_id, logo_url, footer_note').eq('workspace_id', workspaceId).maybeSingle()
  if (error) { console.warn('Workspace branding lookup failed:', error.message); return defaultBranding }
  return normalizeBranding(data)
}

const normalizeProductRecord = data => data ? ({ ...data, price: Number(data.price), cost_price: Number(data.cost_price ?? data.costPrice ?? 0), tax: Number(data.tax ?? data.tax_rate ?? 0), tax_rate: Number(data.tax_rate ?? data.tax ?? 0), stock: Number(data.stock ?? data.inventory_count ?? 0), reorder_level: Number(data.reorder_level ?? data.reorderLevel ?? 5) }) : null

async function findProduct(key, workspaceId) {
  const normalized = String(key || '').trim()
  if (!normalized) return null
  if (supabase) {
    let barcodeQuery = supabase.from('products').select('*').eq('barcode', normalized)
    if (workspaceId) barcodeQuery = barcodeQuery.eq('workspace_id', workspaceId)
    const barcodeResult = await barcodeQuery.maybeSingle()
    if (barcodeResult.error) console.warn('Barcode product lookup failed:', barcodeResult.error.message)
    if (barcodeResult.data) return normalizeProductRecord(barcodeResult.data)

    let skuQuery = supabase.from('products').select('*').ilike('sku', normalized)
    if (workspaceId) skuQuery = skuQuery.eq('workspace_id', workspaceId)
    const skuResult = await skuQuery.maybeSingle()
    if (skuResult.error) console.warn('SKU product lookup failed:', skuResult.error.message)
    if (skuResult.data) return normalizeProductRecord(skuResult.data)
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

async function insertInvoiceWithSchemaFallback(payload) {
  let candidate = { ...payload }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await supabase.from('invoices').insert(candidate).select('*').single()
    if (!result.error) return result
    const column = missingColumnName(result.error)
    if (!isMissingProductColumn(result.error) || !column || !(column in candidate)) return result
    delete candidate[column]
  }
  return { data: null, error: new Error('The invoices table has too many unsupported columns. Check its schema.') }
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

async function loadStaff(workspaceId) {
  if (!supabase || !workspaceId) return []
  const { data, error } = await supabase.from('profiles').select('id, full_name, role, workspace_id, owner_id, username, can_apply_discounts, can_delete_cart_items, can_view_reports, can_edit_inventory, is_active, last_active_at').eq('workspace_id', workspaceId).order('full_name')
  if (error) { toast.error(`Failed to load staff: ${error.message}`); return [] }
  return data || []
}

async function hashPin(pin) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function findProfileByPin(pin, workspaceId) {
  if (!supabase || !workspaceId) return null
  const pinHash = await hashPin(pin)
  const { data, error } = await supabase.from('profiles').select('id, full_name, role, workspace_id, owner_id, username, pin_hash, is_active, can_apply_discounts, can_delete_cart_items, can_view_reports, can_edit_inventory').eq('workspace_id', workspaceId).eq('pin_hash', pinHash).eq('is_active', true).maybeSingle()
  if (error) { console.warn('Register PIN lookup failed:', error.message); return null }
  return data
}

const mapInvoiceRow = row => ({ id: row.invoice_number || row.id, customer: row.customer_name || row.customer || 'Customer', date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—', items: row.invoice_items || row.items || [], subtotal: Number(row.subtotal || 0), tax: Number(row.tax || row.tax_amount || 0), total: Number(row.total || row.total_amount || 0), discount: Number(row.discount || 0), status: row.status || 'Pending', payment: row.payment_method || row.payment || 'Pending', customer_id: row.customer_id || null, created_by_staff_id: row.created_by_staff_id || null, workspace_id: row.workspace_id })

async function loadInvoices(workspaceId) {
  if (!supabase) return seedInvoices
  let query = supabase.from('invoices').select('*, invoice_items(*)').order('created_at', { ascending: false })
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query
  if (error) { console.warn('Invoice loading failed:', error.message); return [] }
  if (!data?.length) return []
  return data.map(mapInvoiceRow)
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
  id: product?.id || null,
  barcode: String(product?.barcode || ''),
  name: String(product?.name || 'Unnamed Item'),
  sku: String(product?.sku || product?.barcode || product?.name || 'ITEM')
})

const sameCartProduct = (left, right) => {
  if (left?.id && right?.id) return String(left.id) === String(right.id)
  if (left?.barcode && right?.barcode) return String(left.barcode) === String(right.barcode)
  return Boolean(left?.sku && right?.sku) && String(left.sku).toLowerCase() === String(right.sku).toLowerCase()
}
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

function printThermalReceipt({ items, subtotal, tax, total, discount = 0, branding = defaultBranding }) {
  const popup = window.open('', '_blank', 'width=360,height=720')
  if (!popup) return toast.error('Allow pop-ups to print the receipt')
  const safeBranding = normalizeBranding(branding)
  const upiLink = safeBranding.upi_id ? `upi://pay?pa=${encodeURIComponent(safeBranding.upi_id)}&pn=${encodeURIComponent(safeBranding.store_name)}&am=${Number(total || 0).toFixed(2)}&cu=INR` : ''
  const qr = upiLink ? `<img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(upiLink)}" alt="UPI payment QR"/>` : ''
  const lines = items.map(item => `<div class="line"><span>${item.name}<small>${item.quantity} x ${money(item.price)}</small></span><b>${money(item.price * item.quantity)}</b></div>`).join('')
  popup.document.write(`<!doctype html><html><head><title>${safeBranding.store_name} receipt</title><style>@page{size:80mm auto;margin:0}body{width:72mm;margin:0 auto;padding:5mm 3mm;font:12px monospace;color:#111}.head{text-align:center;border-bottom:1px dashed #111;padding-bottom:8px;margin-bottom:8px}.logo{max-width:42mm;max-height:18mm;object-fit:contain}.head h2{font-size:18px;margin:5px 0 2px}.tagline,.meta,.footer{font-size:10px;line-height:1.4}.line{display:flex;justify-content:space-between;gap:8px;margin:7px 0}.line span{max-width:48%}.line small{display:block;margin-top:2px}.totals{border-top:1px dashed #111;margin-top:10px;padding-top:8px}.total{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;margin-top:6px}.upi{text-align:center;border-top:1px dashed #111;margin-top:10px;padding-top:10px}.qr{width:30mm;height:30mm}.footer{text-align:center;margin-top:14px}@media print{button{display:none}}</style></head><body><div class="head">${safeBranding.logo_url ? `<img class="logo" src="${safeBranding.logo_url}" alt="Store logo"/>` : ''}<h2>${safeBranding.store_name}</h2><div class="tagline">${safeBranding.tagline}</div><div class="meta">${safeBranding.address}</div><div class="meta">${safeBranding.contact_phone}${safeBranding.contact_phone && safeBranding.contact_email ? ' · ' : ''}${safeBranding.contact_email}</div>${safeBranding.tax_id ? `<div class="meta">GSTIN: ${safeBranding.tax_id}</div>` : ''}<div class="meta">${new Date().toLocaleString('en-IN')}</div></div>${lines}<div class="totals"><div>Subtotal: ${money(subtotal)}</div>${discount ? `<div>Discount: -${money(discount)}</div>` : ''}<div>GST: ${money(tax)}</div><div class="total"><span>Total</span><span>${money(total)}</span></div></div>${upiLink ? `<div class="upi">${qr}<div>Pay via UPI: ${safeBranding.upi_id}</div></div>` : ''}<p class="footer">${safeBranding.footer_note}</p></body></html>`)
  popup.document.close()
  popup.focus()
  popup.print()
  popup.close()
}

async function downloadInvoicePdf({ invoice, subtotal, tax, total, branding }) {
  const safeBranding = normalizeBranding(branding)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  let y = 22
  try {
    let logoData = safeBranding.logo_url
    if (logoData && !logoData.startsWith('data:')) {
      const response = await fetch(logoData)
      const blob = await response.blob()
      logoData = await new Promise(resolve => { const reader = new FileReader(); reader.onloadend = () => resolve(reader.result); reader.readAsDataURL(blob) })
    }
    if (logoData?.startsWith('data:image/')) {
      doc.addImage(logoData, 'AUTO', 20, 12, 30, 15)
      y = 34
    }
  } catch (error) { console.warn('Logo could not be embedded in PDF:', error) }
  doc.setFontSize(18); doc.setFont(undefined, 'bold'); doc.text(safeBranding.store_name, 20, y)
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); y += 6; doc.text(safeBranding.tagline || '', 20, y)
  y += 6; doc.text([safeBranding.address, safeBranding.contact_phone, safeBranding.contact_email].filter(Boolean).join(' · '), 20, y)
  if (safeBranding.tax_id) { y += 6; doc.text(`GSTIN: ${safeBranding.tax_id}`, 20, y) }
  y += 14; doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.text(`Invoice ${invoice.id}`, 20, y); doc.setFont(undefined, 'normal'); doc.setFontSize(10); doc.text(`${invoice.date} · ${invoice.status}`, 150, y, { align: 'right' })
  y += 12; doc.text(`Billed to: ${invoice.customer}`, 20, y); y += 10; doc.line(20, y, 190, y); y += 8
  invoice.items.forEach(item => { doc.text(`${item.name} (${item.quantity} x ${money(item.price)})`, 20, y); doc.text(money(item.price * item.quantity), 190, y, { align: 'right' }); y += 7 })
  y += 5; doc.line(120, y, 190, y); y += 8; doc.text(`Subtotal: ${money(subtotal)}`, 190, y, { align: 'right' }); y += 7; doc.text(`GST: ${money(tax)}`, 190, y, { align: 'right' }); y += 8; doc.setFont(undefined, 'bold'); doc.setFontSize(13); doc.text(`Total paid: ${money(total)}`, 190, y, { align: 'right' }); doc.setFont(undefined, 'normal'); doc.setFontSize(10)
  y += 16; if (safeBranding.upi_id) doc.text(`UPI: ${safeBranding.upi_id}`, 20, y); y += 8; doc.text(safeBranding.footer_note, 20, y, { maxWidth: 170 })
  doc.save(`${invoice.id}.pdf`)
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
    try { if (supabase) { let result; if (mode === 'login') { result = await supabase.auth.signInWithPassword({ email, password }) } else { result = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName || email.split('@')[0], role } } }); if (result.error && /already registered|user already exists/i.test(result.error.message)) result = await supabase.auth.signInWithPassword({ email, password }) } if (result.error) throw result.error; if (mode === 'signup' && !result.data.session) { setError('Account created. Check your email to confirm, then sign in.'); setMode('login'); return } if (!result.data.user) throw new Error('Unable to start your session.'); const profile = await getProfile(result.data.user.id); onAuth(mapAuthUser(result.data.user, profile, role)) } else { onAuth({ email, name: fullName || email.split('@')[0], role }) } } catch (err) { setError(err.message || 'Authentication failed. Please try again.') } finally { setBusy(false) }
  }
  return <main className="auth-shell"><section className="auth-card"><div className="brand auth-brand"><div className="brand-mark">B</div><span>Bill<span>Flow</span></span></div><h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1><p className="muted">{supabaseConfigured ? 'Securely sign in with Supabase Auth.' : 'Preview mode is active. Add Supabase keys for production authentication.'}</p>{!supabaseConfigured && <div className="notice">Supabase is not configured. Demo sessions are kept in this browser only.</div>}<div className="auth-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError('') }}>Login</button><button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError('') }}>Sign up</button></div><form onSubmit={submit}>{mode === 'signup' && <label>Full name<input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="Your name" required /></label>}<label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@shop.com" autoComplete="email" required /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 6 characters" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>{mode === 'signup' && <label>Workspace role<select value={role} onChange={event => setRole(event.target.value)}><option>Owner</option><option>Employee</option><option>Customer</option></select></label>}{error && <p className="form-error">{error}</p>}<button className="primary-btn full" disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Login to BillFlow' : 'Create account'}</button></form></section></main>
}

function Layout({ user, onLogout, onToggleTheme, darkMode, onLockRegister, children }) { const [menuOpen, setMenuOpen] = useState(false); const [mobileNavOpen, setMobileNavOpen] = useState(false); const location = useLocation(); const title = location.pathname === '/' ? 'Overview' : location.pathname.slice(1).split('/')[0].replace(/\b\w/g, x => x.toUpperCase()); const links = [{ path: '/', label: 'Overview', icon: 'grid', roles: ['Owner'] }, { path: '/pos', label: 'POS billing', icon: 'invoice', roles: ['Owner', 'Employee'] }, { path: '/inventory', label: 'Inventory', icon: 'barcode', roles: ['Owner', 'Employee'] }, { path: '/invoices', label: 'Invoices', icon: 'invoice', roles: ['Owner', 'Employee', 'Customer'] }, { path: '/customers', label: 'Customers', icon: 'users', roles: ['Owner'] }, { path: '/reports', label: 'Reports', icon: 'chart', roles: ['Owner'] }]; return <div className="app-shell"><aside className={mobileNavOpen ? 'sidebar mobile-open' : 'sidebar'}><div className="brand"><div className="brand-mark">B</div><span>Bill<span>Flow</span></span></div><div className="workspace-label">WORKSPACE</div><nav className="main-nav">{links.filter(link => link.roles.includes(user.role) && (link.path !== '/reports' || user.permissions?.can_view_reports !== false)).map(link => <NavLink end={link.path === '/'} key={link.path} to={link.path} onClick={() => setMobileNavOpen(false)} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon name={link.icon}/><span>{link.label}</span></NavLink>)}</nav><div className="workspace-label second">MANAGE</div>{user.role === 'Owner' && <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon name="settings"/><span>Settings</span></NavLink>}<div className="sidebar-bottom"><div className="user-mini"><div className="avatar purple">{initials(user.name)}</div><div><strong>{user.name}</strong><small>{user.role} account</small></div><button type="button" aria-label="Open account menu" aria-expanded={menuOpen} className="account-menu-trigger" onClick={() => setMenuOpen(value => !value)}><Icon name="more" size={18}/></button>{menuOpen && <div className="account-popover" role="menu"><button type="button" role="menuitem" onClick={() => setMenuOpen(false)}>View Profile</button>{user.role === 'Owner' && <NavLink role="menuitem" to="/settings" onClick={() => setMenuOpen(false)}>Workspace Settings</NavLink>}<button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onLogout() }}>Sign Out</button></div>}</div></div></aside>{mobileNavOpen && <button className="mobile-nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}/>}<section className="main-area"><header className="topbar"><button className="mobile-menu-btn" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Icon name="more" size={20}/></button><div><div className="breadcrumb">Workspace <span>/</span> {title}</div><h1>{title}</h1></div><div className="top-actions"><button className="lock-register-btn" onClick={onLockRegister}>Lock Register / Switch User</button><button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">{darkMode ? 'Light' : 'Dark'} mode</button><span className="role-badge">{user.role}</span><div className="top-avatar">{initials(user.name)}</div></div></header><main className="content">{children}</main></section></div> }

function Protected({ user, roles, children }) { return roles.includes(user.role) ? children : <Navigate to="/invoices" replace /> }
const ProductSearch = memo(function ProductSearch({ onAdd, products: catalog }) { const [query, setQuery] = useState(''); const [debouncedQuery, setDebouncedQuery] = useState(''); useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 300); return () => window.clearTimeout(timer) }, [query]); const matches = useMemo(() => { const normalized = debouncedQuery.toLowerCase(); return catalog.filter(item => `${item.name} ${item.sku} ${item.barcode}`.toLowerCase().includes(normalized)).slice(0, 50) }, [catalog, debouncedQuery]); return <section className="panel product-search"><div className="search-box"><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search product, SKU or barcode…" /></div><div className="product-results">{matches.map(item => <button key={item.id || item.sku} onClick={() => onAdd(item)}><span><strong>{item.name}</strong><small>{item.sku} · {item.barcode}</small></span><b>{money(item.price)}</b></button>)}</div></section> })
function CameraScannerModal({ onCode, onClose }) {
  const scannerRef = useRef(null)
  const scanLockRef = useRef(false)
  const cooldownTimerRef = useRef(null)
  const onCodeRef = useRef(onCode)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCodeRef.current = onCode
    onCloseRef.current = onClose
  }, [onCode, onClose])
  const [message, setMessage] = useState('Requesting camera permission…')
  const [scanConfirmed, setScanConfirmed] = useState(false)
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
        const handleDecoded = async decoded => {
          if (!mounted || scanLockRef.current) return
          scanLockRef.current = true
          setScanConfirmed(true)
          setMessage('Barcode captured ✓')
          try { playBarcodeBeep() } catch (error) { console.warn('Barcode beep unavailable:', error) }
          cooldownTimerRef.current = window.setTimeout(() => {
            if (!mounted) return
            scanLockRef.current = false
            setScanConfirmed(false)
            setMessage('Ready — scan the next barcode')
          }, 1000)
          const added = await onCodeRef.current(decoded)
          if (!added) setMessage(`Scanned ${decoded}, but no matching product was found`)
          window.setTimeout(() => {
            if (mounted) setScanConfirmed(false)
          }, 750)
        }
        await scanner.start({ facingMode: 'environment' }, { fps: 12, qrbox: { width: 320, height: 110 }, aspectRatio: 1.777, disableFlip: false, formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.ITF] }, handleDecoded, () => {})
        if (mounted) setMessage('Scanning continuously — 1s delay after each scan')
      } catch (error) {
        if (mounted) setMessage(error?.message?.toLowerCase().includes('permission') ? 'Camera permission was denied. Enable it in browser settings.' : 'Camera could not start. Check camera access and HTTPS, then use manual entry.')
        scannerRef.current = null
      }
    }
    start()
    return () => {
      mounted = false
      scanLockRef.current = true
      if (cooldownTimerRef.current) window.clearTimeout(cooldownTimerRef.current)
      const scanner = scannerRef.current
      scannerRef.current = null
      if (scanner) {
        ;(async () => {
          try { await scanner.stop() } catch (error) { console.warn('Camera stop failed:', error) }
          try { await scanner.clear() } catch (error) { console.warn('Camera cleanup failed:', error) }
        })()
      }
    }
  }, [])

  return <div className="modal-backdrop" onClick={event => event.target === event.currentTarget && onCloseRef.current()}><section className="modal camera-modal"><div className="modal-head"><div><p className="eyebrow">CAMERA SCANNER</p><h3>Scan Barcode</h3></div><button className="close-btn" onClick={onClose}><Icon name="close"/></button></div><div className="camera-box is-scanning"><div id={scannerId} className="camera-reader"/><div className="scanner-frame" aria-hidden="true"><i/><i/><i/><i/></div>{scanConfirmed && <div className="scan-confirmation" aria-live="polite">✓</div>}</div><small className="muted">{message}</small></section></div>
}

function Scanner({ onCode }) {
  const [open, setOpen] = useState(false)
  return <section className="scanner panel"><div className="panel-heading"><div><h3>Barcode scanner</h3><p className="muted">Use your device camera as a fallback</p></div><button className="secondary-btn" onClick={() => setOpen(true)}><Icon name="camera" size={16}/> Open camera</button></div>{open && <CameraScannerModal onCode={onCode} onClose={() => setOpen(false)}/>}<div className="camera-placeholder compact-placeholder"><Icon name="camera" size={26}/><span>USB/Bluetooth scanner and manual entry are also supported.</span></div></section>
}

function Cart({ cart, setCart, onCheckout, canDeleteCartItems, onOwnerOverride }) {
  const subtotal = cart.reduce((sum, item) => sum + Number(item?.price || 0) * Number(item?.quantity || 0), 0)
  const tax = cart.reduce((sum, item) => sum + Number(item?.price || 0) * Number(item?.quantity || 0) * Number(item?.tax_rate ?? item?.tax ?? 0) / 100, 0)
  const total = subtotal + tax
  const change = (target, amount) => setCart(items => items.map(item => sameCartProduct(item, target) ? { ...item, quantity: Math.max(0, Number(item.quantity || 0) + amount) } : item).filter(item => item.quantity))
  const remove = item => {
    if (canDeleteCartItems) return setCart(items => items.filter(candidate => !sameCartProduct(candidate, item)))
    onOwnerOverride?.(() => setCart(items => items.filter(candidate => !sameCartProduct(candidate, item))))
  }
  return <section className="panel cart-panel"><div className="panel-heading"><div><h3>Current cart</h3><p className="muted">{cart.reduce((sum, item) => sum + Number(item?.quantity || 0), 0)} items</p></div><button className="text-btn" onClick={() => canDeleteCartItems ? setCart([]) : onOwnerOverride?.(() => setCart([]))}>Clear</button></div>{cart.length === 0 ? <div className="empty-friendly compact"><Icon name="invoice" size={28}/><p>Scan or search products to begin.</p></div> : <div className="cart-lines">{cart.map(item => <div className="cart-line" key={item.id || `${item.barcode || item.sku}-${item.sku}`}><div><strong>{item.name || 'Unnamed Item'}</strong><small>{item.sku || '—'} · {money(item.price)} + {Number(item.tax_rate ?? item.tax ?? 0)}% GST</small></div><div className="quantity"><button onClick={() => change(item, -1)}>−</button><b>{item.quantity || 0}</b><button onClick={() => change(item, 1)}>+</button></div><strong>{money(Number(item?.price || 0) * Number(item?.quantity || 0))}</strong><button className="remove-cart-btn" onClick={() => remove(item)} aria-label={`Remove ${item.name}`} title={canDeleteCartItems ? 'Remove item' : 'Owner PIN required'}>×</button></div>)}</div>}<div className="totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>GST</span><b>{money(tax)}</b></div><div className="grand-total"><span>Total</span><strong>{money(total)}</strong></div></div><button className="primary-btn full" disabled={!cart.length} onClick={() => onCheckout({ subtotal, tax, total })}>Create invoice</button></section>
}

function CustomerPicker({ workspaceId, onChange }) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const search = useCallback(async value => {
    const normalized = value.trim()
    if (!supabase || !workspaceId || normalized.length < 2) return setMatches([])
    const { data, error } = await supabase.from('customers').select('id, full_name, phone, email').eq('workspace_id', workspaceId).or(`phone.ilike.%${normalized}%,full_name.ilike.%${normalized}%`).limit(8)
    if (error) { console.warn('Customer lookup failed:', error.message); return }
    setMatches(data || [])
  }, [workspaceId])
  useEffect(() => { const timer = window.setTimeout(() => search(query), 300); return () => window.clearTimeout(timer) }, [query, search])
  const create = async event => {
    event.preventDefault()
    if (!newName.trim() || !newPhone.trim() || !supabase || !workspaceId) return toast.error('Customer name and phone are required')
    const { data, error } = await supabase.from('customers').upsert({ workspace_id: workspaceId, full_name: newName.trim(), phone: newPhone.trim() }, { onConflict: 'workspace_id,phone' }).select('*').single()
    if (error) return toast.error(`Could not save customer: ${error.message}`)
    onChange(data); setQuery(data.full_name); setMatches([]); setNewName(''); setNewPhone(''); toast.success('Customer saved')
  }
  return <section className="panel customer-picker"><label>Customer lookup <small className="muted">Optional · scoped to this workspace</small><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name or phone" /></label>{matches.length > 0 && <div className="customer-suggestions">{matches.map(item => <button type="button" key={item.id} onClick={() => { onChange(item); setQuery(item.full_name); setMatches([]) }}><strong>{item.full_name}</strong><small>{item.phone}</small></button>)}</div>}<form className="customer-quick-form" onSubmit={create}><input value={newName} onChange={event => setNewName(event.target.value)} placeholder="New customer name"/><input value={newPhone} onChange={event => setNewPhone(event.target.value)} placeholder="Phone number" inputMode="tel"/><button className="secondary-btn">Add customer</button></form></section>
}

function POS({ onInvoice, catalog, user, operator, permissions, branding, onOwnerOverride }) {
  const [cart, setCart] = useState([])
  const [manual, setManual] = useState('')
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [checkoutSummary, setCheckoutSummary] = useState(null)
  const [receiptData, setReceiptData] = useState(null)
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const add = useCallback(product => {
    const safeProduct = normalizeScannedProduct(product)
    setCart(previousCart => {
      const existingIndex = previousCart.findIndex(item => sameCartProduct(item, safeProduct))
      if (existingIndex === -1) return [...previousCart, { ...safeProduct, quantity: 1 }]
      return previousCart.map((item, index) => index === existingIndex ? { ...item, ...safeProduct, quantity: Number(item.quantity || 0) + 1 } : item)
    })
    setManual('')
    try { navigator.vibrate?.(60) } catch (error) { console.warn('Vibration unavailable:', error) }
    toast.success(`${safeProduct.name} added`)
  }, [])

  const code = async value => {
    const normalized = String(value || '').trim()
    if (!normalized) return false
    let product
    try {
      product = await findProduct(normalized, user?.workspace_id)
    } catch (error) {
      console.error('Barcode product lookup failed:', error)
      toast.error(`Unable to look up barcode ${normalized}`)
      return false
    }
    if (product) {
      try { playBarcodeBeep() } catch (error) { console.warn('Barcode beep unavailable:', error) }
      add(normalizeScannedProduct(product))
      return true
    }
    toast.error(`Product not found for barcode ${normalized}`)
    return false
  }

  useBarcodeScanner(code, true)

  const checkout = summary => { setCheckoutSummary(summary); setPaymentOpen(true) }
  const complete = async ({ payment, discount }) => {
    const discountAmount = permissions.can_apply_discounts ? Math.max(0, Math.min(Number(discount || 0), Number(checkoutSummary?.subtotal || 0))) : 0
    const discountedSubtotal = Math.max(0, Number(checkoutSummary?.subtotal || 0) - discountAmount)
    const discountedTax = Number(checkoutSummary?.tax || 0) * (discountedSubtotal / Math.max(1, Number(checkoutSummary?.subtotal || 0)))
    const finalTotal = discountedSubtotal + discountedTax
    const saved = await onInvoice({ customer: selectedCustomer?.full_name || 'Walk-in customer', customer_id: selectedCustomer?.id || null, items: cart, ...checkoutSummary, subtotal: discountedSubtotal, tax: discountedTax, total: finalTotal, discount: discountAmount, payment, status: 'Paid' })
    if (!saved) return
    setReceiptData({ items: cart, ...checkoutSummary, subtotal: discountedSubtotal, tax: discountedTax, total: finalTotal, discount: discountAmount })
    setCart([])
    setPaymentOpen(false)
    toast.success('Payment recorded and receipt created')
  }

  const lowStockItems = useMemo(() => cart.filter(item => item.stock != null && item.stock <= Number(item.min_stock_alert ?? 10)), [cart])
  const catalogLowStockCount = useMemo(() => catalog.filter(item => item.stock != null && item.stock <= Number(item.min_stock_alert ?? 10)).length, [catalog])
  const printReceipt = () => {
    const printable = receiptData || (checkoutSummary && cart.length ? { items: cart, ...checkoutSummary } : null)
    if (!printable) return toast.error('Complete a bill before printing a receipt')
    printThermalReceipt({ ...printable, branding })
  }

  return <>
    <section className="page-intro"><div><p className="muted">Quick Billing Counter <span className="live-dot">● Live</span></p><small className="muted">{operator?.name || user?.name} · USB/Bluetooth gun ready · scan a barcode ending with Enter</small></div><div className="low-stock-summary">{catalogLowStockCount} low-stock alerts</div></section>
    <div className="pos-grid"><div><Scanner onCode={code}/><CustomerPicker workspaceId={user?.workspace_id} onChange={setSelectedCustomer}/><div className="panel manual-entry"><label>Manual barcode / SKU entry<div className="inline-form"><input value={manual} onChange={event => setManual(event.target.value)} onKeyDown={event => event.key === 'Enter' && code(manual)} placeholder="8901234567890 or RICE-5KG" autoFocus/><button className="primary-btn" onClick={() => code(manual)}>Add item</button></div></label></div><ProductSearch onAdd={add} products={catalog}/></div><div><Cart cart={cart} setCart={setCart} canDeleteCartItems={permissions.can_delete_cart_items} onOwnerOverride={onOwnerOverride} onCheckout={checkout}/>{lowStockItems.length > 0 && <div className="low-stock-warning"><strong>Low-stock warning</strong><span>{lowStockItems.map(item => `${item.name} (${item.stock} left)`).join(' · ')}</span></div>}{receiptData && <button className="secondary-btn print-receipt-btn" onClick={printReceipt}>Print Receipt</button>}</div></div>
    {paymentOpen && <PaymentModal total={checkoutSummary?.total || 0} canApplyDiscounts={permissions.can_apply_discounts} branding={branding} onClose={() => setPaymentOpen(false)} onComplete={complete}/>} 
  </>
}

function PaymentModal({ total, canApplyDiscounts, branding, onClose, onComplete }) { const [method, setMethod] = useState('UPI'); const [discount, setDiscount] = useState(''); const finalTotal = Math.max(0, Number(total) - (canApplyDiscounts ? Number(discount || 0) : 0)); const safeBranding = normalizeBranding(branding); const upiLink = safeBranding.upi_id ? `upi://pay?pa=${encodeURIComponent(safeBranding.upi_id)}&pn=${encodeURIComponent(safeBranding.store_name)}&am=${finalTotal.toFixed(2)}&cu=INR` : ''; return <div className="modal-backdrop"><section className="modal payment-modal"><div className="modal-head"><div><p className="eyebrow">SECURE CHECKOUT</p><h3>Collect {money(finalTotal)}</h3></div><button className="close-btn" onClick={onClose}><Icon name="close"/></button></div><label className="discount-field">Custom discount<input type="number" min="0" max={total} step="0.01" value={discount} disabled={!canApplyDiscounts} onChange={event => setDiscount(event.target.value)} placeholder={canApplyDiscounts ? '0.00' : 'Owner permission required'}/>{!canApplyDiscounts && <small className="muted">Your role cannot apply checkout discounts.</small>}</label><div className="payment-methods">{['UPI', 'Cash', 'Card'].map(item => <button key={item} className={method === item ? 'selected' : ''} onClick={() => setMethod(item)}>{item}</button>)}</div>{method === 'UPI' && <div className="upi-panel">{upiLink ? <QRCodeSVG value={upiLink} size={130}/>: <div className="qr-placeholder">QR</div>}<p>{safeBranding.upi_id ? `Pay ${safeBranding.store_name} via UPI` : 'Add a UPI ID in Settings to enable checkout QR'}</p>{upiLink && <a href={upiLink}>Open UPI payment · {safeBranding.upi_id}</a>}</div>}<button className="primary-btn full" onClick={() => onComplete({ payment: method, discount: canApplyDiscounts ? discount : 0 })}><Icon name="check" size={16}/> Mark {method} paid</button></section></div> }
function Inventory({ catalog, onCreate, onUpdate, onDelete, onAdjustStock }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const showReorderOnly = searchParams.get('filter') === 'reorder'
  const emptyForm = { name: '', sku: '', barcode: '', category: '', image_url: '', description: '', price: '', cost_price: '', stock: '', min_stock_alert: '10', reorder_level: '5', tax: '18' }
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(50)
  const [barcodeStatus, setBarcodeStatus] = useState('')
  const barcodeRef = useRef(null)
  useEffect(() => { barcodeRef.current?.focus() }, [editingId])
  const updateField = (field, value) => setForm(current => ({ ...current, [field]: value }))
  const checkBarcode = value => {
    const normalized = String(value || '').trim()
    if (!normalized) return setBarcodeStatus('')
    const existing = catalog.find(item => String(item.barcode || '').trim() === normalized && (item.id || item.sku) !== editingId)
    setBarcodeStatus(existing ? `Barcode already belongs to ${existing.name}` : 'Barcode is available')
  }
  const lookupBarcode = async value => {
    const normalized = String(value || '').trim()
    if (!normalized || normalized.length < 6) return
    const existing = catalog.find(item => String(item.barcode || '').trim() === normalized && (item.id || item.sku) !== editingId)
    if (existing) {
      setBarcodeStatus(`Already in inventory: ${existing.name}. Edit this product to adjust its stock.`)
      setForm(current => ({ ...current, barcode: normalized, name: existing.name || current.name, category: existing.category || current.category, image_url: existing.image_url || current.image_url, description: existing.description || current.description }))
      return
    }
    setLookupBusy(true)
    try {
      const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(normalized)}.json`)
      const result = await response.json()
      if (result.status === 1 && result.product) {
        const product = result.product
        setForm(current => ({ ...current, barcode: normalized, name: current.name || product.product_name || product.product_name_en || '', category: current.category || product.categories || product.categories_tags?.[0]?.replace(/^en:/, '') || '', image_url: current.image_url || product.image_front_url || product.image_url || '', description: current.description || product.generic_name || product.ingredients_text || '' }))
        setBarcodeStatus(`Open Food Facts match found${product.brands ? ` · ${product.brands}` : ''}`)
      } else setBarcodeStatus('Barcode is available. Enter the product details below.')
    } catch (error) {
      console.warn('Open Food Facts lookup failed:', error)
      setBarcodeStatus('Barcode is available. Product lookup was unavailable.')
    } finally { setLookupBusy(false) }
  }
  const scanInventoryBarcode = value => {
    const normalized = String(value || '').trim()
    if (!normalized) return
    updateField('barcode', normalized)
    checkBarcode(normalized)
    lookupBarcode(normalized)
    try { playBarcodeBeep() } catch (error) { console.warn('Barcode beep unavailable:', error) }
    toast.success('Barcode captured')
    return true
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
  const lowStockItems = useMemo(() => catalog.filter(item => item.stock != null && Number(item.stock) <= Number(item.reorder_level ?? item.reorderLevel ?? 5)), [catalog])
  const visibleCatalog = useMemo(() => (showReorderOnly ? lowStockItems : catalog).slice(0, visibleLimit), [catalog, lowStockItems, showReorderOnly, visibleLimit])
  const totalVisibleProducts = showReorderOnly ? lowStockItems.length : catalog.length
  const setReorderFilter = enabled => {
    setVisibleLimit(50)
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
    if (/already in inventory|barcode already/i.test(barcodeStatus)) {
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
    setForm({ name: item.name || '', sku: item.sku || '', barcode: item.barcode || '', category: item.category || '', image_url: item.image_url || item.image || '', description: item.description || '', price: String(item.price ?? ''), cost_price: String(item.cost_price ?? item.costPrice ?? 0), tax: String(item.tax ?? 0), stock: item.stock == null ? '' : String(item.stock), min_stock_alert: String(item.min_stock_alert ?? 10), reorder_level: String(item.reorder_level ?? item.reorderLevel ?? 5) })
  }
  const cancelEdit = () => { setEditingId(null); setForm(emptyForm); setBarcodeStatus('') }

  return <>
    <section className="page-intro"><div><p className="muted">Inventory & Barcode Manager</p><small className="muted">Live product catalog from Supabase</small></div><button type="button" className={showReorderOnly ? 'secondary-btn selected-filter' : 'secondary-btn'} onClick={() => setReorderFilter(!showReorderOnly)}>Low Stock Alerts <b>{lowStockItems.length}</b></button></section>
    <section className="panel low-stock-alert-panel"><div className="alert-panel-head"><div><p className="eyebrow">REORDER MONITOR</p><h3>Low Stock Alerts</h3><p className="muted">Products at or below their reorder level.</p></div><button type="button" className={showReorderOnly ? 'text-btn' : 'secondary-btn'} onClick={() => setReorderFilter(!showReorderOnly)}>{showReorderOnly ? 'Show all products' : 'View reorder items'}</button></div>{lowStockItems.length ? <div className="alert-items">{lowStockItems.map(item => { const status = getStockStatus(item); return <div className="alert-item" key={item.id || item.sku}><span><strong>{item.name}</strong><small>{item.stock == null ? 'Untracked stock' : `${item.stock} units on hand`} · reorder at {Number(item.reorder_level ?? 5)}</small></span><span className={status.className}>{status.label}</span></div> })}</div> : <p className="alert-clear">All tracked products are above their reorder levels.</p>}</section>
    <section className="panel invoice-page-panel inventory-manager">
      <form className="inventory-form" onSubmit={submit}><h3>{editingId ? 'Edit product' : 'Add product'}</h3><div className="form-grid"><label>Product Name<input value={form.name} onChange={event => updateField('name', event.target.value)} placeholder="Premium Rice 5kg" required /></label><label>SKU<input value={form.sku} onChange={event => updateField('sku', event.target.value)} placeholder="RICE-5KG" required /></label><label>Barcode<div className="field-with-action"><input ref={barcodeRef} value={form.barcode} onChange={event => { updateField('barcode', event.target.value); checkBarcode(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); lookupBarcode(event.currentTarget.value) } }} onBlur={event => lookupBarcode(event.target.value)} placeholder="Scan or enter barcode" autoFocus /><button type="button" className="secondary-btn compact-btn" onClick={() => setCameraOpen(true)}>Camera Scan</button><button type="button" className="secondary-btn compact-btn" onClick={generateBarcode}>Generate Random Barcode</button></div>{lookupBusy && <small className="muted">Looking up barcode…</small>}{barcodeStatus && <small className={barcodeStatus.startsWith('Already') || barcodeStatus.startsWith('Barcode already') ? 'danger-text' : 'success-text'}>{barcodeStatus}</small>}</label><label>Category<input value={form.category} onChange={event => updateField('category', event.target.value)} placeholder="Groceries" /></label><label>Image URL<input value={form.image_url} onChange={event => updateField('image_url', event.target.value)} placeholder="https://.../product.jpg" /></label><label className="wide">Description<textarea value={form.description} onChange={event => updateField('description', event.target.value)} placeholder="Product description" rows="2" /></label><label>Price<input type="number" min="0" step="0.01" value={form.price} onChange={event => updateField('price', event.target.value)} required /></label><label>Cost Price<input type="number" min="0" step="0.01" value={form.cost_price} onChange={event => updateField('cost_price', event.target.value)} /></label><label>Stock Quantity<input type="number" min="0" step="1" value={form.stock} onChange={event => updateField('stock', event.target.value)} placeholder="Leave blank if untracked" /></label><label>Reorder Level<input type="number" min="0" step="1" value={form.reorder_level} onChange={event => updateField('reorder_level', event.target.value)} /></label><label>Min Stock Alert<input type="number" min="0" step="1" value={form.min_stock_alert} onChange={event => updateField('min_stock_alert', event.target.value)} /></label><label>GST Rate (%)<input type="number" min="0" step="0.01" value={form.tax} onChange={event => updateField('tax', event.target.value)} /></label></div><div className="form-actions"><button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Update product' : 'Add product'}</button>{editingId && <button type="button" className="secondary-btn" onClick={cancelEdit}>Cancel</button>}</div></form>
      <div className="product-results">{visibleCatalog.length ? visibleCatalog.map(item => { const status = getStockStatus(item); const itemId = item.id || item.sku; const stock = item.stock == null ? 0 : Number(item.stock); return <div className="inventory-row" key={itemId}><span><strong>{item.name}</strong><small>{item.sku} · {item.barcode || 'No barcode'} · {money(item.price)} · Cost {money(item.cost_price || 0)} · Reorder at {Number(item.reorder_level ?? 5)}</small></span><span className={status.className}>{item.stock == null ? 'Untracked stock' : `${status.label} · ${stock}`}</span><span className="stock-adjuster" aria-label={`Adjust stock for ${item.name}`}><button type="button" className="stock-adjust-btn" onClick={() => onAdjustStock(item, -1)} disabled={stock <= 0} aria-label={`Decrease ${item.name} stock`}>−</button><b>{item.stock == null ? '—' : stock}</b><button type="button" className="stock-adjust-btn" onClick={() => onAdjustStock(item, 1)} aria-label={`Increase ${item.name} stock`}>+</button></span><span className="inventory-actions"><button type="button" className="secondary-btn" onClick={() => printBarcodeLabel(item)} disabled={!item.barcode}>Print Barcode Label</button><button type="button" className="secondary-btn" onClick={() => edit(item)}>Edit</button><button type="button" className="text-btn danger-text" onClick={() => onDelete(itemId)}>Delete</button></span></div> }) : <div className="empty-friendly compact"><p>{showReorderOnly ? 'No products currently need reordering.' : 'No products found in this workspace.'}</p></div>}</div>{visibleLimit < totalVisibleProducts && <button type="button" className="secondary-btn load-more-btn" onClick={() => setVisibleLimit(limit => limit + 50)}>Load 50 more products</button>}
    </section>{cameraOpen && <CameraScannerModal onCode={code => { setCameraOpen(false); scanInventoryBarcode(code) }} onClose={() => setCameraOpen(false)}/>} 
  </>
}
const InvoiceTable = memo(function InvoiceTable({ invoices }) { const navigate = useNavigate(); return <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>{invoices.map(item => <tr key={item.id}><td data-label="Invoice"><strong className="invoice-id">{item.id}</strong></td><td data-label="Customer">{item.customer}</td><td data-label="Date" className="muted">{item.date}</td><td data-label="Amount"><strong>{money(item.total || item.items?.reduce((sum, x) => sum + x.price * x.quantity * (1 + x.tax / 100), 0) || 0)}</strong></td><td data-label="Status"><span className={`status ${item.status.toLowerCase()}`}><i/>{item.status}</span></td><td data-label="Open"><button className="more-btn" onClick={() => navigate(`/invoice/${item.id}`)}><Icon name="arrow" size={16}/></button></td></tr>)}</tbody></table></div> })
function Invoices({ invoices }) { const [query, setQuery] = useState(''); const [debouncedQuery, setDebouncedQuery] = useState(''); useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 300); return () => window.clearTimeout(timer) }, [query]); const filtered = useMemo(() => invoices.filter(item => `${item.id} ${item.customer}`.toLowerCase().includes(debouncedQuery.toLowerCase())), [invoices, debouncedQuery]); return <><section className="page-intro"><p className="muted">Shareable digital invoices and customer payment status.</p></section><section className="panel invoice-page-panel"><div className="toolbar"><div className="search-box"><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search invoices or customers…" autoFocus/></div></div><InvoiceTable invoices={filtered}/></section></> }
function InvoiceDetail({ invoices, branding }) { const { id } = useParams(); const invoice = invoices.find(item => item.id === id); if (!invoice) return <section className="panel empty-friendly"><h3>Invoice not found</h3><p className="muted">This link may be expired or the invoice was removed.</p></section>; const safeBranding = normalizeBranding(branding); const subtotal = invoice.subtotal ?? invoice.items.reduce((sum, item) => sum + item.price * item.quantity, 0); const tax = invoice.tax ?? invoice.items.reduce((sum, item) => sum + item.price * item.quantity * item.tax / 100, 0); const total = invoice.total ?? subtotal + tax; const upiLink = safeBranding.upi_id ? `upi://pay?pa=${encodeURIComponent(safeBranding.upi_id)}&pn=${encodeURIComponent(safeBranding.store_name)}&am=${Number(total).toFixed(2)}&cu=INR` : ''; return <section className="invoice-detail panel"><div className="digital-branding">{safeBranding.logo_url && <img src={safeBranding.logo_url} alt={`${safeBranding.store_name} logo`}/>}<div><h2>{safeBranding.store_name}</h2><p>{safeBranding.tagline}</p><small>{safeBranding.address}{safeBranding.contact_phone ? ` · ${safeBranding.contact_phone}` : ''}{safeBranding.contact_email ? ` · ${safeBranding.contact_email}` : ''}</small>{safeBranding.tax_id && <small>GSTIN: {safeBranding.tax_id}</small>}</div></div><div className="receipt-head"><div><p className="eyebrow">DIGITAL INVOICE</p><h2>{invoice.id}</h2><p className="muted">{invoice.date}</p></div><span className={`status ${invoice.status.toLowerCase()}`}><i/>{invoice.status}</span></div><div className="receipt-customer"><span>Billed to</span><strong>{invoice.customer}</strong></div>{invoice.items.map(item => <div className="receipt-item" key={item.sku}><span>{item.name}<small>{item.quantity} × {money(item.price)}</small></span><strong>{money(item.price * item.quantity)}</strong></div>)}<div className="totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div>{invoice.discount > 0 && <div><span>Discount</span><b>-{money(invoice.discount)}</b></div>}<div><span>GST</span><b>{money(tax)}</b></div><div className="grand-total"><span>Total paid</span><strong>{money(total)}</strong></div></div>{safeBranding.footer_note && <p className="digital-footer">{safeBranding.footer_note}</p>}<div className="receipt-actions"><div className="share-box"><input readOnly value={`${window.location.origin}/receipt/${invoice.id}`} onFocus={event => event.target.select()}/><button className="secondary-btn" onClick={() => { navigator.clipboard?.writeText(window.location.href); toast.success('Receipt link copied') }}>Copy link</button></div><button className="secondary-btn" onClick={() => downloadInvoicePdf({ invoice, subtotal, tax, total, branding: safeBranding })}>Download PDF</button><a className="whatsapp-btn" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`${safeBranding.store_name} receipt ${invoice.id}: ${money(total)} ${window.location.origin}/receipt/${invoice.id}`)}`}>Send on WhatsApp</a>{upiLink && <div className="payment-qr"><QRCodeSVG value={upiLink} size={112}/><small>Pay via UPI: {safeBranding.upi_id}</small></div>}<div className="payment-qr"><QRCodeSVG value={`${window.location.origin}/receipt/${invoice.id}`} size={96}/><small>Scan to view receipt</small></div></div></section> }
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
function StaffManagement({ staff, onCreateStaff, onUpdateStaff, onResetPin, onDeactivate }) {
  const emptyForm = { full_name: '', email: '', username: '', role: 'cashier', access_pin: '' }
  const [form, setForm] = useState(emptyForm)
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [permissions, setPermissions] = useState({ can_apply_discounts: false, can_delete_cart_items: false, can_view_reports: false, can_edit_inventory: false })
  const openPermissions = profile => { setSelected(profile); setPermissions(profilePermissions(profile)); setModal('permissions') }
  const submitStaff = async event => { event.preventDefault(); if (!form.full_name.trim() || !form.email.trim() || !/^\d{4}$/.test(form.access_pin) || !['cashier', 'manager'].includes(form.role)) return toast.error('Full name, email, cashier/manager role, and exactly 4 PIN digits are required'); setBusy(true); const ok = await onCreateStaff(form); setBusy(false); if (ok) { setForm(emptyForm); setModal(null) } }
  const savePermissions = async event => { event.preventDefault(); setBusy(true); const ok = await onUpdateStaff(selected.id, permissions); setBusy(false); if (ok) setModal(null) }
  const activeStaff = staff.filter(profile => profile.is_active !== false)
  return <section className="panel staff-management"><div className="staff-management-head"><div><p className="eyebrow">OWNER ACCESS</p><h3>Employee Management</h3><p className="muted">Manage workspace staff, checkout permissions, and register access.</p></div><button className="primary-btn" onClick={() => setModal('add')}>Add New Staff Member</button></div><div className="table-scroll"><table className="staff-directory"><thead><tr><th>Staff member</th><th>Role</th><th>Last active</th><th>Status</th><th>Quick actions</th></tr></thead><tbody>{activeStaff.length ? activeStaff.map(profile => <tr key={profile.id}><td><strong>{profile.full_name || 'Unnamed employee'}</strong><small>{profile.email || 'Auth email'}</small></td><td><span className="role-pill">{String(profile.role || 'cashier').replace(/^./, value => value.toUpperCase())}</span></td><td className="muted">{profile.last_active_at ? new Date(profile.last_active_at).toLocaleString() : 'Not active yet'}</td><td><span className="status paid"><i/>Active</span></td><td><div className="staff-actions"><button className="secondary-btn" onClick={() => openPermissions(profile)}>Edit Permissions</button><button className="text-btn" onClick={() => onResetPin(profile)}>Reset PIN</button><button className="text-btn danger-text" onClick={() => onDeactivate(profile)}>Deactivate</button></div></td></tr>) : <tr><td colSpan="5" className="empty-friendly compact">No active employees yet.</td></tr>}</tbody></table></div>{staff.some(profile => profile.is_active === false) && <p className="muted staff-inactive-note">{staff.filter(profile => profile.is_active === false).length} deactivated profile(s) hidden from the active directory.</p>}{modal === 'add' && <div className="modal-backdrop"><section className="modal staff-modal"><div className="modal-head"><div><p className="eyebrow">NEW STAFF</p><h3>Add New Staff Member</h3></div><button className="close-btn" onClick={() => setModal(null)}><Icon name="close"/></button></div><form className="staff-form" onSubmit={submitStaff}><label>Name<input value={form.full_name} onChange={event => setForm({ ...form, full_name: event.target.value })} required /></label><label>Email<input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} required /></label><label>Role<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="cashier">Cashier</option><option value="manager">Manager</option></select></label><label>Username<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} placeholder="cashier-01" /></label><label>4-Digit Quick PIN<input inputMode="numeric" pattern="[0-9]{4}" minLength="4" maxLength="4" value={form.access_pin} onChange={event => setForm({ ...form, access_pin: event.target.value.replace(/\D/g, '').slice(0, 4) })} required /><small className="muted">The PIN is hashed by the trusted staff provisioning function.</small></label><div className="form-actions"><button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button><button className="primary-btn" disabled={busy}>{busy ? 'Creating…' : 'Create staff member'}</button></div></form></section></div>}{modal === 'permissions' && selected && <div className="modal-backdrop"><section className="modal staff-modal"><div className="modal-head"><div><p className="eyebrow">PERMISSIONS</p><h3>{selected.full_name}</h3></div><button className="close-btn" onClick={() => setModal(null)}><Icon name="close"/></button></div><form className="permission-list" onSubmit={savePermissions}>{Object.entries({ can_apply_discounts: 'Apply checkout discounts', can_delete_cart_items: 'Delete cart items', can_view_reports: 'View reports', can_edit_inventory: 'Edit inventory' }).map(([key, label]) => <label className="permission-toggle" key={key}><span><strong>{label}</strong><small>{key === 'can_apply_discounts' ? 'Allow custom discounts during payment.' : key === 'can_delete_cart_items' ? 'Allow removing items without Owner PIN.' : key === 'can_view_reports' ? 'Allow report navigation and analytics.' : 'Allow product and stock edits.'}</small></span><input type="checkbox" checked={Boolean(permissions[key])} disabled={String(selected.role).toLowerCase() === 'owner'} onChange={event => setPermissions({ ...permissions, [key]: event.target.checked })}/></label>)}<div className="form-actions"><button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button><button className="primary-btn" disabled={busy || String(selected.role).toLowerCase() === 'owner'}>{busy ? 'Saving…' : 'Save permissions'}</button></div></form></section></div>}</section>
}

function BrandingSettings({ branding, onSave }) {
  const [form, setForm] = useState(normalizeBranding(branding))
  const [busy, setBusy] = useState(false)
  const update = (field, value) => setForm(current => ({ ...current, [field]: value }))
  const uploadLogo = event => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) return toast.error('Choose an image file')
    if (file.size > 1024 * 1024) return toast.error('Logo must be 1 MB or smaller')
    const reader = new FileReader()
    reader.onload = () => update('logo_url', String(reader.result || ''))
    reader.readAsDataURL(file)
  }
  const submit = async event => { event.preventDefault(); setBusy(true); const saved = await onSave(form); setBusy(false); if (saved) toast.success('Branding is ready for receipts and invoices') }
  return <section className="panel branding-panel"><div className="panel-heading"><div><p className="eyebrow">STORE IDENTITY</p><h3>Store & Invoice Branding</h3><p className="muted">These details appear on POS receipts, digital invoices, and checkout UPI payments.</p></div>{form.logo_url && <img className="branding-logo-preview" src={form.logo_url} alt="Store logo preview"/>}</div><form className="branding-form" onSubmit={submit}><div className="form-grid"><label>Store name<input value={form.store_name} onChange={event => update('store_name', event.target.value)} placeholder="BillFlow Store" required/></label><label>Tagline<input value={form.tagline} onChange={event => update('tagline', event.target.value)} placeholder="Simple billing for growing shops"/></label><label className="wide">Store address<textarea value={form.address} onChange={event => update('address', event.target.value)} placeholder="12 Market Road, Pune" rows="2"/></label><label>Contact phone<input value={form.contact_phone} onChange={event => update('contact_phone', event.target.value)} placeholder="+91 98765 43210"/></label><label>Contact email<input type="email" value={form.contact_email} onChange={event => update('contact_email', event.target.value)} placeholder="hello@storename.com"/></label><label>Tax ID / GSTIN<input value={form.tax_id} onChange={event => update('tax_id', event.target.value)} placeholder="27AABCU9603R1ZM"/></label><label>UPI payment ID<input value={form.upi_id} onChange={event => update('upi_id', event.target.value)} placeholder="storename@upi"/><small className="muted">Used to generate a checkout payment QR.</small></label><label className="wide">Store logo URL<input value={form.logo_url.startsWith('data:') ? '' : form.logo_url} onChange={event => update('logo_url', event.target.value)} placeholder="https://.../logo.png"/><small className="muted">Or choose a local image below. Keep it under 1 MB.</small><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={uploadLogo}/></label><label className="wide">Receipt footer note<textarea value={form.footer_note} onChange={event => update('footer_note', event.target.value)} rows="2" placeholder="Thank you for shopping with us!"/></label></div><div className="form-actions"><button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save branding'}</button></div></form></section>
}

function Settings({ branding, onSaveBranding, staff, onCreateStaff, onUpdateStaff, onResetPin, onDeactivate }) {
  const [saved, setSaved] = useState(false)
  const [tax, setTax] = useState('18%')
  const [prefix, setPrefix] = useState('INV-2026-')
  const [sequence, setSequence] = useState('001')
  const [size, setSize] = useState('3-inch')
  return <><section className="page-intro"><p className="muted">Store identity, billing preferences, and team access.</p></section><BrandingSettings key={`${branding.store_name}-${branding.upi_id}-${branding.logo_url.slice(0, 24)}`} branding={branding} onSave={onSaveBranding}/><div className="settings-layout"><section className="panel settings-form"><h3>Store profile</h3><div className="form-grid"><label>Shop name<input defaultValue="BillFlow Store"/></label><label>GSTIN number<input placeholder="27AABCU9603R1ZM"/></label><label>Contact phone<input placeholder="+91 98765 43210"/></label><label>Invoice logo<input type="file" accept="image/*"/></label><label className="wide">Address<textarea placeholder="Store address"/></label></div><h3>Billing preferences</h3><div className="form-grid"><label>Default GST rate<select value={tax} onChange={event => setTax(event.target.value)}><option>0%</option><option>5%</option><option>12%</option><option>18%</option></select></label><label>Invoice prefix<input value={prefix} onChange={event => setPrefix(event.target.value)}/></label><label>Next sequence<input value={sequence} onChange={event => setSequence(event.target.value)}/></label><label>Thermal receipt size<select value={size} onChange={event => setSize(event.target.value)}><option>2-inch</option><option>3-inch</option></select></label></div><button className="primary-btn" onClick={() => { setSaved(true); toast.success('Workspace settings saved') }}>{saved ? 'Saved' : 'Save settings'}</button></section><StaffManagement staff={staff} onCreateStaff={onCreateStaff} onUpdateStaff={onUpdateStaff} onResetPin={onResetPin} onDeactivate={onDeactivate}/></div></>
}
function SimplePage({ title, text, icon = 'users' }) { return <section className="panel empty-friendly"><div className="big-soft-icon peach"><Icon name={icon} size={30}/></div><h3>{title}</h3><p className="muted">{text}</p></section> }

function RegisterLock({ user, onUnlock, onSwitchUser, onLogout }) { const [pin, setPin] = useState(''); const [busy, setBusy] = useState(false); const submit = async event => { event.preventDefault(); if (!/^\d{4}$/.test(pin)) return toast.error('Enter the staff member’s 4-digit PIN'); setBusy(true); const nextUser = await onSwitchUser(pin); setBusy(false); if (nextUser) onUnlock(nextUser); else toast.error('Incorrect PIN or inactive staff member') }; return <div className="register-lock-overlay"><section className="modal register-lock-card"><div className="brand auth-brand"><div className="brand-mark">B</div><span>Bill<span>Flow</span></span></div><p className="eyebrow">REGISTER LOCKED</p><h2>Switch user</h2><p className="muted">Enter a 4-digit PIN for an active member of this workspace. Owner and staff financial access stays locked until validation succeeds.</p><form onSubmit={submit}><label>Staff PIN<input autoFocus inputMode="numeric" type="password" maxLength="4" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Enter 4-digit PIN" /></label><button className="primary-btn full" disabled={busy}>{busy ? 'Checking…' : `Unlock register${user?.name ? ` · ${user.name}` : ''}`}</button></form><button className="secondary-btn full" onClick={onLogout}>Sign out completely</button></section></div> }

function OwnerOverrideModal({ onConfirm, onClose }) { const [pin, setPin] = useState(''); return <div className="modal-backdrop"><section className="modal staff-modal"><div className="modal-head"><div><p className="eyebrow">OWNER OVERRIDE</p><h3>Owner PIN required</h3></div><button className="close-btn" onClick={onClose}><Icon name="close"/></button></div><p className="muted">This employee does not have permission for that cart action.</p><label>Owner PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, ''))}/></label><button className="primary-btn full" onClick={() => pin === '1234' ? onConfirm() : toast.error('Incorrect owner PIN. Demo PIN is 1234.')}>Approve action</button></section></div> }

function App() { const [user, setUser] = useState(() => supabase ? null : getDemoUser()); const [activeOperator, setActiveOperator] = useState(() => supabase ? null : getDemoUser()); const [darkMode, setDarkMode] = useState(() => localStorage.getItem('billflow-theme') === 'dark'); const [catalog, setCatalog] = useState(() => supabase ? [] : products); const [invoices, setInvoices] = useState(() => { if (supabase) return []; try { return JSON.parse(localStorage.getItem('billflow-invoices')) || seedInvoices } catch { return seedInvoices } }); const [staff, setStaff] = useState([]); const [branding, setBranding] = useState(defaultBranding); const [registerLocked, setRegisterLocked] = useState(false); const [overrideAction, setOverrideAction] = useState(null); useEffect(() => { localStorage.setItem('billflow-invoices', JSON.stringify(invoices)) }, [invoices]); useEffect(() => { localStorage.setItem('billflow-theme', darkMode ? 'dark' : 'light'); document.body.dataset.theme = darkMode ? 'dark' : 'light' }, [darkMode]); useEffect(() => { let mounted = true; if (supabase) { supabase.auth.getSession().then(async ({ data }) => { if (!mounted || !data.session?.user) return; const profile = await getProfile(data.session.user.id); if (mounted) { const nextUser = mapAuthUser(data.session.user, profile); setUser(nextUser); setActiveOperator(nextUser) } }); const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => { if (!session?.user) return setUser(null); const profile = await getProfile(session.user.id); if (mounted) { const nextUser = mapAuthUser(session.user, profile); setUser(nextUser); setActiveOperator(nextUser) } }); return () => { mounted = false; listener.subscription.unsubscribe() } } return () => { mounted = false } }, []); useEffect(() => { if (!supabase || !user?.id) return; loadProducts(user.workspace_id).then(setCatalog); loadInvoices(user.workspace_id).then(setInvoices); loadWorkspaceBranding(user.workspace_id).then(setBranding); if (supabase) supabase.from('profiles').update({ last_active_at: new Date().toISOString() }).eq('id', user.id).eq('workspace_id', user.workspace_id).then(({ error }) => { if (error) console.warn('Last active update failed:', error.message) }); if (user.role === 'Owner') loadStaff(user.workspace_id).then(setStaff) }, [user?.id, user?.workspace_id, user?.role]); const updateCatalogStocks = updates => setCatalog(current => current.map(item => {
    const update = updates.find(candidate => (candidate.id && candidate.id === item.id) || candidate.sku === item.sku)
    return update ? { ...item, stock: update.stock } : item
  }))
  const saveBranding = async nextBranding => {
    const next = normalizeBranding(nextBranding)
    if (!supabase) { setBranding(next); toast.success('Branding saved in preview mode'); return true }
    const { data, error } = await supabase.from('workspace_settings').upsert({ workspace_id: user.workspace_id, ...next }, { onConflict: 'workspace_id' }).select('*').single()
    if (error) { toast.error(`Failed to save branding: ${error.message}`); return false }
    setBranding(normalizeBranding(data)); toast.success('Store branding saved'); return true
  }
  const switchRegisterOperator = async pin => {
    if (!user?.workspace_id) return null
    if (!supabase && pin === '1234') return user
    if (supabase) {
      const profile = await findProfileByPin(pin, user.workspace_id)
      if (profile) return mapAuthUser({ id: profile.id, email: profile.username }, profile)
      if (pin === '1234' && user.role === 'Owner') return user
    }
    return null
  }
  const refreshStaff = async () => { if (user?.workspace_id) setStaff(await loadStaff(user.workspace_id)) }
  const createStaff = async details => {
    if (!supabase) { setStaff(current => [...current, { id: `demo-${Date.now()}`, full_name: details.full_name, email: details.email, role: details.role, is_active: true, last_active_at: null, ...profilePermissions({ role: details.role }) }]); toast.success('Staff member added in preview mode'); return true }
    const { data, error } = await supabase.functions.invoke('create-staff', { body: { ...details, workspace_id: user.workspace_id } })
    if (error || data?.error) { toast.error(error?.message || data.error); return false }
    toast.success('Staff credentials created securely'); await refreshStaff(); return true
  }
  const updateStaff = async (id, updates) => {
    if (!supabase) { setStaff(current => current.map(profile => profile.id === id ? { ...profile, ...updates } : profile)); toast.success('Permissions saved'); return true }
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', id).eq('workspace_id', user.workspace_id).select('*').single()
    if (error) { toast.error(`Failed to save permissions: ${error.message}`); return false }
    setStaff(current => current.map(profile => profile.id === id ? data : profile)); toast.success('Permissions saved directly to public.profiles'); return true
  }
  const deactivateStaff = async profile => { if (!window.confirm(`Deactivate ${profile.full_name || 'this staff member'}?`)) return false; return updateStaff(profile.id, { is_active: false }) }
  const resetStaffPin = async profile => { const pin = window.prompt(`Enter a new 4-8 digit PIN for ${profile.full_name || 'this staff member'}`); if (!/^\d{4,8}$/.test(pin || '')) return toast.error('PIN must contain 4 to 8 digits'); if (!supabase) return toast.success('PIN reset in preview mode'); const { error } = await supabase.functions.invoke('create-staff', { body: { action: 'reset_pin', user_id: profile.id, pin, workspace_id: user.workspace_id } }); if (error) return toast.error(error.message); toast.success('PIN reset securely') }
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
      const payload = { invoice_number: invoiceNumber, customer_name: data.customer, customer_id: data.customer_id || null, subtotal: data.subtotal, tax: data.tax, total: data.total, discount: data.discount || 0, status: data.status, payment_method: data.payment, created_by_staff_id: activeOperator?.id || user?.id, ...(user?.workspace_id ? { workspace_id: user.workspace_id } : {}) }
      const { data: created, error } = await insertInvoiceWithSchemaFallback(payload)
      if (error) {
        toast.error(`Failed to create invoice: ${error.message}`)
        return false
      }
      if (data.items?.length && created?.id) {
        const lines = data.items.map(item => ({ invoice_id: created.id, workspace_id: user?.workspace_id, product_id: item.id || null, product_name: item.name, quantity: item.quantity, unit_price: item.price, tax_rate: item.tax, line_total: item.price * item.quantity * (1 + item.tax / 100) }))
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
  return <BrowserRouter>{user ? <Layout user={activeOperator || user} darkMode={darkMode} onToggleTheme={() => setDarkMode(value => !value)} onLockRegister={() => setRegisterLocked(true)} onLogout={async () => { await supabase?.auth.signOut(); localStorage.removeItem('billflow-user'); setUser(null) }}><Routes><Route path="/" element={<Protected user={activeOperator || user} roles={['Owner']}><Overview invoices={invoices} catalog={catalog}/></Protected>}/><Route path="/pos" element={<Protected user={activeOperator || user} roles={['Owner', 'Employee']}><ErrorBoundary><POS onInvoice={createInvoice} catalog={catalog} user={user} operator={activeOperator} permissions={activeOperator?.permissions || user.permissions || profilePermissions(user)} branding={branding} onOwnerOverride={action => setOverrideAction(() => action)}/></ErrorBoundary></Protected>}/><Route path="/invoices" element={<Invoices invoices={invoices}/>}/><Route path="/invoice/:id" element={<InvoiceDetail invoices={invoices} branding={branding}/>}/><Route path="/receipt/:id" element={<InvoiceDetail invoices={invoices} branding={branding}/>}/><Route path="/inventory" element={<Protected user={activeOperator || user} roles={['Owner', 'Employee']}>{user.role === 'Owner' || user.permissions?.can_edit_inventory ? <Inventory catalog={catalog} onCreate={createProduct} onUpdate={updateProduct} onDelete={deleteProduct} onAdjustStock={adjustStock}/> : <SimplePage title="Inventory access restricted" text="Your owner can grant inventory editing permission from Settings." icon="barcode"/>}</Protected>}/><Route path="/customers" element={<Protected user={activeOperator || user} roles={['Owner']}><SimplePage title="Customer management" text="Owner-only customer records and billing history."/></Protected>}/><Route path="/reports" element={<Protected user={activeOperator || user} roles={['Owner']}><Reports invoices={invoices}/></Protected>}/><Route path="/settings" element={<Protected user={activeOperator || user} roles={['Owner']}><Settings branding={branding} onSaveBranding={saveBranding} staff={staff} onCreateStaff={createStaff} onUpdateStaff={updateStaff} onResetPin={resetStaffPin} onDeactivate={deactivateStaff}/></Protected>}/><Route path="*" element={<Navigate to="/invoices" replace/>}/></Routes>{registerLocked && <RegisterLock user={activeOperator || user} onSwitchUser={switchRegisterOperator} onUnlock={nextOperator => { setActiveOperator(nextOperator); setRegisterLocked(false) }} onLogout={async () => { await supabase?.auth.signOut(); localStorage.removeItem('billflow-user'); setUser(null) }}/>} {overrideAction && <OwnerOverrideModal onClose={() => setOverrideAction(null)} onConfirm={() => { const action = overrideAction; setOverrideAction(null); action?.() }}/>}</Layout> : <Routes><Route path="/invoice/:id" element={<InvoiceDetail invoices={invoices} branding={branding}/>}/><Route path="/receipt/:id" element={<InvoiceDetail invoices={invoices} branding={branding}/>}/><Route path="*" element={<Auth onAuth={nextUser => { localStorage.setItem('billflow-user', JSON.stringify(nextUser)); setUser(nextUser) }}/>}/></Routes>}<Toaster position="bottom-right"/></BrowserRouter> }

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>)
