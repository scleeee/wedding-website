import { createClient } from 'npm:@supabase/supabase-js@^2'

const MAX_TOKEN_LENGTH = 256

const responseHeaders = {
  'Cache-Control': 'no-store, private, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function supabaseServerKey(): string {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (serviceRoleKey) return serviceRoleKey

  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, unknown>
      if (typeof parsed.default === 'string' && parsed.default) return parsed.default
    } catch {
      // Fall through to the generic startup error below.
    }
  }

  throw new Error('Missing Supabase server credential')
}

const supabase = createClient(requiredEnv('SUPABASE_URL'), supabaseServerKey(), {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') {
    return jsonResponse({ code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  const token = request.headers.get('x-rsvp-sheet-token')
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return jsonResponse({ code: 'UNAUTHORIZED' }, 401)
  }

  const { data, error } = await supabase.rpc('export_rsvp_submissions_for_sheet', {
    p_token: token,
  })

  if (error) {
    if (error.code === '28000') {
      return jsonResponse({ code: 'UNAUTHORIZED' }, 401)
    }

    console.error('Google Sheet RSVP export failed', error.code ?? 'unknown')
    return jsonResponse({ code: 'SERVICE_UNAVAILABLE' }, 503)
  }

  return jsonResponse({ rows: data ?? [] })
})
