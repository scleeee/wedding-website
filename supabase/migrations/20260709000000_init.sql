-- Invite codes: one row per household/party invited (e.g. "SMITH2027").
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code)),
  party_name text,
  num_seats int not null check (num_seats > 0),
  created_at timestamptz not null default now()
);

-- Guests: one row per seat on an invite. Rows are pre-created (one per
-- num_seats) when a host adds an invite, then filled in / edited by the
-- guest when they RSVP.
create table public.guests (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.invites(id) on delete cascade,
  seat_number int not null check (seat_number > 0),
  -- Host's private planning value, set when the invite is created (e.g.
  -- "John Smith"). Never returned by the guest-facing API — for the
  -- hosts' own reference/reconciliation only.
  expected_name text,
  -- What the guest actually enters/confirms when they RSVP.
  name text,
  attending boolean,
  dietary_requirements text,
  updated_at timestamptz not null default now(),
  unique (invite_id, seat_number)
);

create index guests_invite_id_idx on public.guests (invite_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger guests_set_updated_at
before update on public.guests
for each row
execute function public.set_updated_at();

-- Deny-by-default: no RLS policies are defined here. All reads/writes go
-- through a server-side API using the service_role key, which bypasses RLS.
-- The anon key never touches these tables directly, so guest names, RSVP
-- status, and dietary info aren't reachable straight from the browser.
alter table public.invites enable row level security;
alter table public.guests enable row level security;
