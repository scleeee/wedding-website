# Architecture & Plans

Working notes on the RSVP backend. Update as decisions change.

## Stack

- **Frontend**: static HTML/CSS/JS (this repo), currently no build step.
- **Database**: Supabase (Postgres), project `wedding-rsvp`.
- **API**: not yet built. Plan is serverless functions (Vercel or Netlify)
  that sit between the frontend and Supabase.

## Access pattern (important)

The frontend never talks to Supabase directly. All reads/writes go through
the serverless API using Supabase's `service_role` key (server-side only,
never shipped to the browser). Row Level Security is enabled on every table
with **no policies**, so even if the anon key ever leaked, it couldn't read
or write guest data.

The API is responsible for enforcing "you can only see/edit your own
invite's guests" by filtering on `invite_id` server-side — there's no
Supabase Auth session per guest, just an invite code passed to the API.

## Schema

- `invites` — one row per household/party. `code` (e.g. `SMITH2027`,
  enforced uppercase), `num_seats`, `party_name`.
- `guests` — one row per seat on an invite, pre-created (`num_seats` rows)
  when a host adds the invite. `expected_name` is the host's private
  planning value (who we expect in that seat), set at invite creation and
  never exposed via the guest-facing API. `name`, `attending`,
  `dietary_requirements` are filled in / edited by the guest when they
  RSVP. Because `expected_name` and `name` live on the same row, no
  separate matching/reconciliation logic is needed — comparing the two
  columns per seat is the "did the RSVP match what we expected" check.

Migrations live in `supabase/migrations/`. Applied manually via the
Supabase SQL editor for now (CLI not installed locally).

## Not built yet

- Serverless API routes: lookup-by-code, submit/update RSVP, host-side
  invite creation.
- Host tooling for creating invites (currently would be manual inserts via
  Supabase dashboard).
- Frontend RSVP UI/JS to call the API.
- Deploy target for the API (Vercel vs Netlify — undecided).
- Any auth/rate-limiting on the invite-code lookup endpoint (someone
  guessing codes is a real concern for a public wedding site).
- Decide whether the RSVP form prefills with `expected_name` (friendlier,
  fewer typos) or leaves `name` blank for the guest to type fresh
  (keeps `expected_name` strictly host-side). Leaning prefill, not decided.
