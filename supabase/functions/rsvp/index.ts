import { createClient } from 'npm:@supabase/supabase-js@^2'

// Allows the database's maximum 50-seat RSVP payload, including UTF-8
// multi-byte dietary text, while still bounding request memory use.
const MAX_BODY_BYTES = 256 * 1024
const MAX_CODE_LENGTH = 128
const MAX_RESPONSES = 50
const MAX_NAME_LENGTH = 200
const MAX_DIETARY_LENGTH = 1000

const LOOKUP_TOTAL_LIMIT = 20
const LOOKUP_TOTAL_WINDOW_SECONDS = 60 * 60
const LOOKUP_FAILED_LIMIT = 5
const LOOKUP_FAILED_WINDOW_SECONDS = 15 * 60
const SUBMIT_LIMIT = 5
const SUBMIT_WINDOW_SECONDS = 60 * 60

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const responseHeaders = {
  ...corsHeaders,
  'Cache-Control': 'no-store, private, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  Expires: '0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
}

type JsonRecord = Record<string, unknown>

type LookupRequest = {
  action: 'lookup'
  code: string
}

type RsvpResponse = {
  seat_number: number
  name: string
  attending: boolean
  dietary_requirements: string
}

type SubmitRequest = {
  action: 'submit'
  code: string
  responses: RsvpResponse[]
}

type RsvpRequest = LookupRequest | SubmitRequest

type Reservation = {
  allowed: boolean
  retryAfterSeconds: number
  token: string
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
      // Fall through to a startup error without exposing secret contents.
    }
  }

  throw new Error('Missing Supabase server credential')
}

const serverKey = supabaseServerKey()
const supabase = createClient(requiredEnv('SUPABASE_URL'), serverKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, ...extraHeaders },
  })
}

function invalidRequest(): Response {
  return jsonResponse(
    { code: 'INVALID_REQUEST', message: 'The RSVP request was not valid.' },
    400,
  )
}

function rateLimited(retryAfterSeconds: number): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds))
  return jsonResponse(
    {
      code: 'RATE_LIMITED',
      message: 'Too many RSVP attempts. Please try again later.',
      retry_after_seconds: retryAfter,
    },
    429,
    { 'Retry-After': String(retryAfter) },
  )
}

function serviceUnavailable(): Response {
  return jsonResponse(
    { code: 'SERVICE_UNAVAILABLE', message: 'The RSVP service is temporarily unavailable.' },
    503,
  )
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: JsonRecord, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function validCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_CODE_LENGTH
    && normalizeCode(value) !== null
}

function normalizeCode(value: string): string | null {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return normalized.length >= 1 && normalized.length <= MAX_CODE_LENGTH
    ? normalized
    : null
}

async function codeDigest(code: string): Promise<string> {
  const normalized = normalizeCode(code)
  if (!normalized) throw new Error('Invalid normalized RSVP code')

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validResponse(value: unknown): value is RsvpResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'seat_number',
    'name',
    'attending',
    'dietary_requirements',
  ])) return false

  return typeof value.seat_number === 'number'
    && Number.isInteger(value.seat_number)
    && value.seat_number >= 1
    && value.seat_number <= MAX_RESPONSES
    && typeof value.name === 'string'
    && value.name.length <= MAX_NAME_LENGTH
    && typeof value.attending === 'boolean'
    && typeof value.dietary_requirements === 'string'
    && value.dietary_requirements.length <= MAX_DIETARY_LENGTH
}

function parseRequest(value: unknown): RsvpRequest | null {
  if (!isRecord(value) || !validCode(value.code)) return null

  if (value.action === 'lookup' && hasOnlyKeys(value, ['action', 'code'])) {
    return { action: 'lookup', code: value.code }
  }

  if (value.action !== 'submit'
    || !hasOnlyKeys(value, ['action', 'code', 'responses'])
    || !Array.isArray(value.responses)
    || value.responses.length < 1
    || value.responses.length > MAX_RESPONSES
    || !value.responses.every(validResponse)) return null

  const seatNumbers = value.responses.map((response) => response.seat_number)
  if (new Set(seatNumbers).size !== seatNumbers.length) return null

  return { action: 'submit', code: value.code, responses: value.responses }
}

async function readJson(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.split(';', 1)[0].trim() !== 'application/json') {
    throw new Error('Invalid content type')
  }

  const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error('Body too large')
  }

  if (!req.body) throw new Error('Missing body')

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('Body too large')
    }
    chunks.push(value)
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return JSON.parse(new TextDecoder().decode(body))
}

function clientIp(req: Request): string {
  // Supabase's edge gateway supplies x-forwarded-for. Never accept an IP from
  // the JSON body or a caller-selected query parameter.
  const forwardedFor = req.headers.get('x-forwarded-for')
  const firstAddress = forwardedFor?.split(',')[0]?.trim()
  if (!firstAddress
    || firstAddress.length > 64
    || !/^[0-9A-Fa-f:.]+$/.test(firstAddress)) return 'unavailable'
  return firstAddress
}

async function ipIdentifier(req: Request): Promise<string> {
  // The hosted server credential is already secret and available only to this
  // Function, so it safely salts identifiers without another deploy secret.
  const input = new TextEncoder().encode(`${serverKey}:${clientIp(req)}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function reserve(key: string, limit: number, windowSeconds: number): Promise<Reservation> {
  const token = crypto.randomUUID()
  const { data, error } = await supabase.rpc('reserve_rsvp_rate_limit', {
    p_bucket: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
    p_member: token,
  })
  if (error || !isRecord(data)
    || typeof data.allowed !== 'boolean'
    || typeof data.retry_after_seconds !== 'number') {
    throw new Error('Unexpected rate-limit response')
  }

  return {
    allowed: data.allowed,
    retryAfterSeconds: Math.max(1, data.retry_after_seconds || windowSeconds),
    token,
  }
}

async function release(key: string, token: string): Promise<void> {
  const { error } = await supabase.rpc('release_rsvp_rate_limit', {
    p_bucket: key,
    p_member: token,
  })
  if (error) throw new Error('Could not release rate-limit reservation')
}

async function lookup(request: LookupRequest, identifier: string): Promise<Response> {
  const total = await reserve(
    `rsvp:v1:lookup-total:${identifier}`,
    LOOKUP_TOTAL_LIMIT,
    LOOKUP_TOTAL_WINDOW_SECONDS,
  )
  if (!total.allowed) return rateLimited(total.retryAfterSeconds)

  const failedKey = `rsvp:v1:lookup-failed:${identifier}`
  const failed = await reserve(failedKey, LOOKUP_FAILED_LIMIT, LOOKUP_FAILED_WINDOW_SECONDS)
  if (!failed.allowed) return rateLimited(failed.retryAfterSeconds)

  // The friendly code is normalized and irreversibly digested at the Edge.
  // Plaintext codes never reach or live in the database.
  const digest = await codeDigest(request.code)
  const { data, error } = await supabase.rpc('lookup_rsvp', {
    p_code_digest: digest,
  })

  if (error) {
    await release(failedKey, failed.token)
    console.error('lookup_rsvp failed', error.code ?? 'unknown')
    return serviceUnavailable()
  }

  if (data === null) {
    // Every invalid code gets the same body and status; the failure reservation
    // remains until the 15-minute window expires.
    return jsonResponse(null)
  }

  await release(failedKey, failed.token)
  return jsonResponse(data)
}

async function submit(request: SubmitRequest, identifier: string): Promise<Response> {
  const submission = await reserve(
    `rsvp:v1:submit:${identifier}`,
    SUBMIT_LIMIT,
    SUBMIT_WINDOW_SECONDS,
  )
  if (!submission.allowed) return rateLimited(submission.retryAfterSeconds)

  const digest = await codeDigest(request.code)
  const { data, error } = await supabase.rpc('submit_rsvp', {
    p_code_digest: digest,
    p_responses: request.responses,
  })

  if (!error) return jsonResponse(data)

  if (error.message === 'RSVP_CLOSED'
    || error.message === 'INVALID_RSVP_CODE'
    || error.message === 'INVALID_RSVP_RESPONSES') {
    // Do not turn submit into a second code-enumeration oracle. Expected
    // application rejections share one status and body.
    return jsonResponse(
      { code: 'RSVP_NOT_SAVED', message: 'The RSVP could not be saved.' },
      400,
    )
  }

  console.error('submit_rsvp failed', error.code ?? 'unknown')
  return serviceUnavailable()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse(
      { code: 'METHOD_NOT_ALLOWED', message: 'Only POST requests are accepted.' },
      405,
      { Allow: 'POST, OPTIONS' },
    )
  }

  let request: RsvpRequest | null
  try {
    request = parseRequest(await readJson(req))
  } catch {
    return invalidRequest()
  }
  if (!request) return invalidRequest()

  try {
    const identifier = await ipIdentifier(req)
    return request.action === 'lookup'
      ? await lookup(request, identifier)
      : await submit(request, identifier)
  } catch (error) {
    // Rate-limit errors fail closed: no lookup or submit RPC is attempted without a
    // successful rate-limit reservation. Never log the code, responses, or IP.
    console.error('RSVP protection failed', error instanceof Error ? error.name : 'unknown')
    return serviceUnavailable()
  }
})
