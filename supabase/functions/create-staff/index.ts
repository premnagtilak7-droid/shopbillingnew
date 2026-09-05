import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

async function hashPin(pin: string) {
  const bytes = new TextEncoder().encode(pin)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    const token = authHeader.replace('Bearer ', '')
    const { data: { user: caller }, error: callerError } = await admin.auth.getUser(token)
    if (callerError || !caller) return json({ error: 'Invalid session' }, 401)
    const body = await request.json()
    const { data: owner, error: ownerError } = await admin.from('profiles').select('workspace_id, role, is_active').eq('id', caller.id).single()
    if (ownerError || owner?.is_active === false || String(owner.role).toLowerCase() !== 'owner') return json({ error: 'Owner access required' }, 403)
    const workspaceId = body.workspace_id || owner.workspace_id
    if (workspaceId !== owner.workspace_id) return json({ error: 'Workspace mismatch' }, 403)

    if (body.action === 'reset_pin') {
      if (!/^\d{4}$/.test(body.pin || '')) return json({ error: 'PIN must contain exactly 4 digits' }, 400)
      const { error } = await admin.from('profiles').update({ pin_hash: await hashPin(body.pin) }).eq('id', body.user_id).eq('workspace_id', workspaceId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (!body.email || !body.full_name || !/^\d{4}$/.test(body.access_pin || '')) return json({ error: 'Name, email, and an exactly 4 digit PIN are required' }, 400)
    const staffRole = String(body.role || 'cashier').toLowerCase()
    if (!['cashier', 'manager'].includes(staffRole)) return json({ error: 'Staff role must be cashier or manager' }, 400)
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email: body.email, email_confirm: true, user_metadata: { full_name: body.full_name, role: staffRole } })
    if (createError || !created.user) return json({ error: createError?.message || 'Unable to create auth user' }, 400)
    const { error: profileError } = await admin.from('profiles').insert({ id: created.user.id, full_name: body.full_name, role: staffRole, owner_id: caller.id, username: body.username || body.email, workspace_id: workspaceId, pin_hash: await hashPin(body.access_pin), is_active: true })
    if (profileError) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: profileError.message }, 400) }
    return json({ ok: true, user_id: created.user.id })
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500) }
})
