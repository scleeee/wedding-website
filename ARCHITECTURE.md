# RSVP architecture

## Request path

The frontend is static HTML/CSS/JavaScript. The invitation content starts hidden
behind a full-page code prompt. That prompt validates the guest's existing RSVP
code through the public Supabase Edge Function at `/functions/v1/rsvp`; a valid
lookup unlocks the page and preloads the matching party's RSVP form. The browser
sends lookup and submission JSON only to that Function.

Because the host serves static files, this is a server-validated user-interface
gate rather than server-level protection for the HTML and image assets. Enforcing
access to the files themselves would require a host with authenticated middleware
or another server-side request boundary.

The Edge Function:

1. validates method, content type, body size, action, code, and response fields;
2. derives the source IP from the Supabase gateway's `x-forwarded-for` header;
3. atomically reserves the applicable Upstash Redis rate limits;
4. calls `public.lookup_rsvp` or `public.submit_rsvp` with a server credential;
5. returns no-store JSON without exposing any server or Redis credential.

The browser does not call Supabase's Data API and does not carry a publishable,
secret, or service-role key. The Function is public by design and its custom
abuse controls fail closed if Redis is unavailable.

## Database boundary

- `public.invites`: one row per household or party.
- `public.guests`: one row per reserved seat.
- RLS is enabled and `anon`/`authenticated` have no direct table privileges.
- `anon`, `authenticated`, and `PUBLIC` cannot execute either RSVP RPC.
- `service_role` alone receives explicit `EXECUTE` grants for the two RPCs.
- Both RPCs are `SECURITY DEFINER` with an empty `search_path` and fully
  qualified object references.

The friendly RSVP code selects one invitation, but it is intentionally treated
as guessable. The protection boundary is the Edge Function plus rate limiter;
stronger assurance requires CAPTCHA and/or a second high-entropy invitation
secret.

Production schema changes live in `supabase/migrations/`. Edge Function code
and its public configuration live in `supabase/functions/rsvp/` and
`supabase/config.toml`. Operational setup, deployment, verification, rotation,
and remaining limitations are documented in `supabase/README.md`.
