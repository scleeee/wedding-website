# RSVP backend and security operations

The static site calls one public Supabase Edge Function at
`/functions/v1/rsvp`. That function validates the request, applies atomic
per-IP limits through protected Postgres RPCs, normalizes and SHA-256 digests the access code,
and only then calls `lookup_rsvp` or `submit_rsvp` with a server-side Supabase
credential. Browser roles cannot execute either RPC or access `invites`,
`guests`, or the `rsvp_submissions` admin view directly. Plaintext access codes
never reach or live in the database.

The function is intentionally public (`verify_jwt = false` in `config.toml`),
so its database rate-limit checks are part of the security boundary. It fails
closed: if a rate-limit reservation fails, it returns 503 without calling a
lookup or submission RPC.
It accepts only JSON requests up to 256 KiB, which accommodates the database's
maximum 50-seat RSVP payload while still bounding request memory use.

## Rate limits

- Lookup failures: 5 per source IP per 15 minutes. A failure slot is reserved
  atomically before the database lookup and released only when the code is
  valid.
- All lookups: 20 per source IP per hour.
- Submissions: 5 per source IP per hour.
- Limited requests receive HTTP 429, `Retry-After`, and
  `retry_after_seconds`.
- Invalid lookup codes all receive the same `200` response with a JSON `null`
  body. Valid and invalid lookup responses include `Cache-Control: no-store`.
- Expected submit rejections (invalid code or responses, or a closed RSVP) use
  one generic response so submission cannot serve as a second lookup oracle.

The IP comes only from the Supabase edge gateway's `x-forwarded-for` header,
following Supabase's Edge Function examples. An IP in the request body or query
string is never accepted. The IP is salted with the hosted server credential
and hashed before it is used in a protected database bucket.

## Credentials

No custom third-party rate-limit secret is required. Hosted Supabase Edge
Functions automatically receive `SUPABASE_URL` and a
server credential (`SUPABASE_SERVICE_ROLE_KEY`, with
`SUPABASE_SECRET_KEYS` supported as the current-key fallback). Do not copy a
service-role or secret key into `rsvp-config.js`, an `.env` file committed to
Git, a browser header, or a response.

Supabase references:

- [Public function and authorization configuration](https://supabase.com/docs/guides/functions/auth)
- [Per-function `verify_jwt` configuration](https://supabase.com/docs/guides/functions/function-configuration)
- [Edge Function environment variables and production secrets](https://supabase.com/docs/guides/functions/secrets)
- [Deploying Edge Functions](https://supabase.com/docs/guides/functions/deploy)
- [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations)

## Prepare and test locally

Install the current Supabase CLI and Docker, then run:

```sh
supabase start
supabase db reset
supabase functions serve rsvp
```

The checked-in `config.toml` disables JWT verification for `rsvp`; the CLI's
`--no-verify-jwt` flag is therefore not needed. Use only synthetic local invite
data for testing. Do not copy the production guest list into the repository.

Example browser-to-Function request shape (the Function sends only a digest to
Postgres):

```json
{ "action": "lookup", "code": "EXAMPLE" }
```

Submission requests use this shape:

```json
{
  "action": "submit",
  "code": "EXAMPLE",
  "responses": [
    {
      "seat_number": 1,
      "name": "Example Guest",
      "attending": true,
      "dietary_requirements": ""
    }
  ]
}
```

## Import guest groups

The private `.cache/guestlist_csv.csv` file is gitignored. Column 1 is used only
to calculate the number of unique names per group; column 2 is the access code.
No CSV name or plaintext code is written to the generated migration.

Regenerate the digest-only seed whenever the private guest list changes:

```sh
python3 supabase/scripts/generate_guest_group_seed.py \
  --input .cache/guestlist_csv.csv \
  --output supabase/migrations/YYYYMMDDHHMMSS_guest_group_seed.sql
```

Name uniqueness is deterministic: Unicode NFKC normalization, collapsed
whitespace, and case folding are applied before counting. Codes are normalized
to uppercase ASCII letters/digits after separators are removed. The generator
fails on empty values, normalized-code collisions, or groups outside the
database's 1–50 slot limit.

The seed treats the private CSV as authoritative: groups absent from the import
are deleted with their RSVP slots. For imported groups it creates missing slots
and removes slots above the allowance, so review/back up existing RSVP data
before deploying a changed guest-list count.

## Production deployment (not performed by this change)

Coordinate the database and Function rollout in a short maintenance window.
The RPC argument changes from plaintext code to code digest, so the old and new
Function/database versions are intentionally incompatible with each other.

```sh
supabase login
supabase link --project-ref ehyoweasqwahqpdzftgt
supabase db push
supabase functions deploy rsvp
```

Deploy the Function immediately after `db push`, then publish the updated static
files (`rsvp-config.js` and `rsvp.js`). The browser request format is unchanged,
so an already-open page works once the new Function is live. Verify a backup
before `db push`; the migration deliberately removes stored plaintext codes and
clears legacy response names that were derived from `expected_name`; the seed
may also remove slots above a group's imported allowance. Existing attendance
and dietary responses within the allowance are preserved.

Do not use `--no-verify-jwt` as an ad hoc deployment-only setting; the public
configuration is checked into `supabase/config.toml` so environments remain
consistent.

## Post-deployment verification

Run this in the Supabase SQL editor after the migration:

```sql
select
  has_function_privilege('anon', 'public.lookup_rsvp(text)', 'EXECUTE')
    as anon_can_lookup,
  has_function_privilege('anon', 'public.submit_rsvp(text, jsonb)', 'EXECUTE')
    as anon_can_submit,
  has_function_privilege('authenticated', 'public.lookup_rsvp(text)', 'EXECUTE')
    as authenticated_can_lookup,
  has_function_privilege('authenticated', 'public.submit_rsvp(text, jsonb)', 'EXECUTE')
    as authenticated_can_submit,
  has_function_privilege('service_role', 'public.lookup_rsvp(text)', 'EXECUTE')
    as service_role_can_lookup,
  has_function_privilege('service_role', 'public.submit_rsvp(text, jsonb)', 'EXECUTE')
    as service_role_can_submit;
```

The first four values must be `false`; the last two must be `true`. Also verify
that direct `/rest/v1/rpc/lookup_rsvp` and `/rest/v1/rpc/submit_rsvp` requests
using the publishable key are rejected, while `/functions/v1/rsvp` returns the
generic response for a synthetic invalid code. Be aware that an invalid live
test consumes a failure slot for the tester's IP.

## Friendly code limitations

A memorable RSVP code is a guessable shared credential, not a strong secret.
Digesting prevents routine plaintext exposure in Supabase but does not add
entropy to the original code. Rate limiting makes online enumeration materially
harder but cannot stop distributed attacks across many IPs, and shared networks
can cause guests to share a limit.
For stronger protection, require a server-validated CAPTCHA such as Cloudflare
Turnstile after several failures and/or print a separate high-entropy invitation
secret in addition to the friendly code. Supabase provides an official
[Turnstile Edge Function example](https://supabase.com/docs/guides/functions/examples/cloudflare-turnstile).

## RSVP data administration

`invites.id` is the opaque guest-group identifier. `guests.invite_id` associates
each submitted row with that group; `name`, `attending`,
`dietary_requirements`, and `submitted_at` are the guest-entered values. The
Supabase dashboard can use `public.rsvp_submissions` for a concise one-row-per-
submitted-guest view. It intentionally contains no access-code digest.

The deprecated `expected_name` and `party_name` planning fields are removed.
Submissions always store only the visitor-entered values. Keep all guest-list
exports and the ignored `.cache` directory out of Git.
