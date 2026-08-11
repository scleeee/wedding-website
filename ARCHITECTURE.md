# RSVP architecture

## Request path

The frontend is static HTML/CSS/JavaScript. The invitation content starts hidden
behind a full-page code prompt. That prompt validates the guest's existing RSVP
code through the public Supabase Edge Function at `/functions/v1/rsvp`; a valid
lookup unlocks the page and preloads the matching party's RSVP form. The browser
sends lookup and submission JSON only to that Function. Between a successful
lookup and the page reveal, the client presents the interactive envelope
animation; skipping or completing it reveals the already-loaded invitation.

Because the host serves static files, this is a server-validated user-interface
gate rather than server-level protection for the HTML and image assets. Enforcing
access to the files themselves would require a host with authenticated middleware
or another server-side request boundary.

The Edge Function:

1. validates method, content type, body size, action, code, and response fields;
2. derives the source IP from the Supabase gateway's `x-forwarded-for` header;
3. atomically reserves the applicable limits through protected Postgres RPCs;
4. normalizes and SHA-256 digests the friendly code before it reaches the
   API-facing RSVP tables;
5. calls `public.lookup_rsvp` or `public.submit_rsvp` with a server credential;
6. returns no-store JSON without exposing any server credential.

The browser does not call Supabase's Data API and does not carry a publishable,
secret, or service-role key. The Function is public by design and its custom
abuse controls fail closed if the protected database rate limiter is unavailable.

## Database boundary

- `public.invites`: one row per household or party, addressed by a code digest
  and opaque UUID. It is the API-facing table and contains no plaintext code.
- `public.rsvp_invite_admin`: protected, host-only dashboard table with the
  readable invite code and editable reserved-seat count. Its trigger keeps the
  digest and RSVP slots in `public.invites`/`public.guests` synchronized.
- `public.guests`: one row per reserved seat, associated through `invite_id`.
  Submitted name, attendance, diet, and per-row submission time live here.
- `public.rsvp_submissions`: a protected admin view with one row per submitted
  guest slot and no access-code field.
- `public.rsvp_submission_audit`: append-only, protected snapshots of every
  full-party RSVP revision. It stores no readable invite code and prevents
  updates or deletes at the application boundary.
- `public.rsvp_rate_limit_events`: short-lived, salted-IP rate-limit reservations
  accessible only through server-role RPCs.
- RLS is enabled and `anon`/`authenticated` have no direct table privileges.
- `anon`, `authenticated`, and `PUBLIC` cannot execute either RSVP RPC.
- `service_role` alone receives explicit `EXECUTE` grants for the two RPCs.
- Both RPCs are `SECURITY DEFINER` with an empty `search_path` and fully
  qualified object references.

The ignored guest-list CSV is processed only by the local seed generator. It
normalizes names with NFKC, collapsed whitespace, and case folding, counts each
normalized name once per normalized code, and emits only code digests plus slot
counts for committed migrations. An optional, ignored local import can load the
same readable codes into `rsvp_invite_admin`; guest-list names are neither
migrated nor returned by the API. A group can retrieve only the RSVP values it
previously submitted using the same code.

The friendly RSVP code remains a guessable shared credential. Its digest is
used on the public API path, while the readable copy is restricted to the host
dashboard table. The protection boundary is the Edge Function plus rate
limiter; stronger assurance requires CAPTCHA and/or a second high-entropy
invitation secret.

Production schema changes live in `supabase/migrations/`. Edge Function code
and its public configuration live in `supabase/functions/rsvp/` and
`supabase/config.toml`. Operational setup, deployment, verification, rotation,
and remaining limitations are documented in `supabase/README.md`.
