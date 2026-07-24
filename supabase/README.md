# RSVP backend and security operations

The static site calls one public Supabase Edge Function at
`/functions/v1/rsvp`. That function validates the request, applies atomic
per-IP limits in Upstash Redis, and only then calls `lookup_rsvp` or
`submit_rsvp` with a server-side Supabase credential. Browser roles cannot
execute either RPC or access `invites` and `guests` directly.

The function is intentionally public (`verify_jwt = false` in `config.toml`),
so its Redis checks are part of the security boundary. It fails closed: if the
rate-limit store is unavailable, it returns 503 without calling an RSVP RPC.
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
string is never accepted. The IP is salted and hashed before it is used in a
Redis key.

## Required secrets

Create an Upstash Global Redis database and obtain its REST credentials. Set
these three Supabase Edge Function secrets:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RSVP_RATE_LIMIT_SALT`: an independent, high-entropy random value (at least
  32 random bytes)

For local work, put placeholders or development values in an ignored file such
as `.env.rsvp.local`:

```dotenv
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace-with-upstash-rest-token
RSVP_RATE_LIMIT_SALT=replace-with-a-long-random-value
```

Never commit that file. The repository's `.gitignore` ignores
`.env.*.local`.

Hosted Supabase Edge Functions automatically receive `SUPABASE_URL` and a
server credential (`SUPABASE_SERVICE_ROLE_KEY`, with
`SUPABASE_SECRET_KEYS` supported as the current-key fallback). Do not copy a
service-role or secret key into `rsvp-config.js`, an `.env` file committed to
Git, a browser header, or a response.

Supabase references:

- [Rate limiting Edge Functions with Upstash Redis](https://supabase.com/docs/guides/functions/examples/rate-limiting)
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
supabase functions serve rsvp --env-file .env.rsvp.local
```

The checked-in `config.toml` disables JWT verification for `rsvp`; the CLI's
`--no-verify-jwt` flag is therefore not needed. Use only synthetic local invite
data for testing. Do not copy the production guest list into the repository.

Example request shape:

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

## Production deployment (not performed by this change)

Coordinate the database, Function, and static-site rollout closely because the
permission migration intentionally breaks the old direct-browser RPC path.

```sh
supabase login
supabase link --project-ref ehyoweasqwahqpdzftgt
supabase secrets set --env-file .env.rsvp.local
supabase functions deploy rsvp
supabase db push
```

Then publish the updated static files (`rsvp-config.js` and `rsvp.js`). The
Function can be deployed before the migration, but it will not successfully
call the RPCs until `service_role` receives the new explicit grants. After the
migration, old browser clients can no longer call the RPCs, so publish the
static update immediately.

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

## Credential rotation

To rotate Upstash credentials, create/rotate the REST token in Upstash, update
`UPSTASH_REDIS_REST_URL` and/or `UPSTASH_REDIS_REST_TOKEN` with
`supabase secrets set`, verify the Function, and revoke the old token. Supabase
makes updated Function secrets available without a redeploy.

Rotate `RSVP_RATE_LIMIT_SALT` with the same command if it may have been exposed.
Changing it starts a new set of hashed-IP keys, so existing counters are reset;
the old keys expire automatically within one hour. Rotate during a low-risk
window and monitor Function/Upstash errors.

## Friendly code limitations

A memorable RSVP code is a guessable identifier, not a strong secret. Rate
limiting makes enumeration materially harder but cannot stop distributed
attacks across many IPs, and shared networks can cause guests to share a limit.
For stronger protection, require a server-validated CAPTCHA such as Cloudflare
Turnstile after several failures and/or print a separate high-entropy invitation
secret in addition to the friendly code. Supabase provides an official
[Turnstile Edge Function example](https://supabase.com/docs/guides/functions/examples/cloudflare-turnstile).

## Invitation data administration

`invites` contains one row per physical invitation. `guests` contains one row
per reserved seat. Create invitations only as an administrator. Store friendly
codes uppercase and without spaces or hyphens; guests may type separators,
which the RPC removes before comparison.

```sql
begin;

with new_invite as (
  insert into public.invites (code, party_name, num_seats, rsvp_deadline)
  values (upper('<FRIENDLY_CODE>'), '<PARTY LABEL>', 2, null)
  returning id, code
), new_seats as (
  insert into public.guests (invite_id, seat_number, expected_name)
  select new_invite.id, seat.seat_number, seat.expected_name
  from new_invite
  cross join (
    values
      (1, '<KNOWN GUEST NAME>'::text),
      (2, null::text)
  ) as seat(seat_number, expected_name)
  returning invite_id
)
select code as code_to_print_on_invitation from new_invite;

commit;
```

For an unnamed partner/guest seat, use `null` for `expected_name`. Never prefill
the response-only `name`, `attending`, or `dietary_requirements` columns. Keep
all guest-list exports and the ignored `.cache` directory out of Git.
