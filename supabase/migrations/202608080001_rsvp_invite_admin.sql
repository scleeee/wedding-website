-- Dashboard-facing RSVP administration. This table intentionally keeps the
-- friendly invite code readable for hosts, while public RSVP access continues
-- to use only the SHA-256 digest in public.invites.

create table public.rsvp_invite_admin (
  id uuid primary key default gen_random_uuid()
    references public.invites(id) on delete cascade,
  invite_code text not null unique,
  reserved_seats integer not null,
  access_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rsvp_invite_admin_code_format_check
    check (
      char_length(invite_code) between 1 and 128
      and invite_code ~ '^[A-Z0-9]+$'
    ),
  constraint rsvp_invite_admin_reserved_seats_check
    check (reserved_seats between 1 and 50)
);

alter table public.rsvp_invite_admin enable row level security;
revoke all on table public.rsvp_invite_admin from public, anon, authenticated;

create or replace function public.sync_rsvp_invite_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_digest text;
  v_existing_invite_id uuid;
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception using errcode = '22023', message = 'RSVP_ADMIN_ID_IMMUTABLE';
  end if;

  v_code := upper(regexp_replace(new.invite_code, '[^A-Za-z0-9]', '', 'g'));
  if char_length(v_code) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_CODE';
  end if;

  new.invite_code := v_code;
  new.updated_at := now();
  v_digest := encode(extensions.digest(v_code, 'sha256'), 'hex');

  if tg_op = 'INSERT' then
    select invitation.id
      into v_existing_invite_id
      from public.invites as invitation
     where invitation.code_digest = v_digest;

    if found then
      -- A generated private import uses this path to attach the readable code
      -- to a pre-existing digest-only invitation without changing its identity.
      -- It also lets the generated import be safely re-run with ON CONFLICT.
      new.id := v_existing_invite_id;
    else
      insert into public.invites (
        id,
        code_digest,
        num_seats,
        access_enabled
      ) values (
        new.id,
        v_digest,
        new.reserved_seats,
        new.access_enabled
      );
    end if;
  else
    if exists (
      select 1
        from public.invites as invitation
       where invitation.code_digest = v_digest
         and invitation.id <> new.id
    ) then
      raise exception using errcode = '23505', message = 'RSVP_CODE_ALREADY_EXISTS';
    end if;
  end if;

  update public.invites as invitation
     set code_digest = v_digest,
         num_seats = new.reserved_seats,
         access_enabled = new.access_enabled
   where invitation.id = new.id;

  -- Keep exactly one RSVP slot per editable reserved seat. Increasing the
  -- count in the dashboard immediately creates the new blank RSVP slot.
  insert into public.guests (invite_id, seat_number)
  select new.id, slot.seat_number
    from generate_series(1, new.reserved_seats) as slot(seat_number)
  on conflict (invite_id, seat_number) do nothing;

  -- Reducing the count removes responses for seats above the new allowance.
  delete from public.guests
   where invite_id = new.id
     and seat_number > new.reserved_seats;

  return new;
end;
$$;

create trigger rsvp_invite_admin_sync
before insert or update on public.rsvp_invite_admin
for each row
execute function public.sync_rsvp_invite_admin();

create or replace function public.delete_rsvp_invite_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deleting an admin row retires the associated code and its RSVP slots.
  delete from public.invites where id = old.id;
  return old;
end;
$$;

create trigger rsvp_invite_admin_delete
after delete on public.rsvp_invite_admin
for each row
execute function public.delete_rsvp_invite_admin();

revoke execute on function public.sync_rsvp_invite_admin() from public, anon, authenticated;
revoke execute on function public.delete_rsvp_invite_admin() from public, anon, authenticated;

comment on table public.rsvp_invite_admin is
  'Host-only dashboard table. Edit invite_code and reserved_seats here; the API uses the synchronized hash in invites.';
comment on column public.rsvp_invite_admin.invite_code is
  'Readable invitation code. Dashboard-only; never exposed to the public RSVP API.';
comment on column public.rsvp_invite_admin.reserved_seats is
  'Editable RSVP seat allowance. Adding a seat creates its blank RSVP slot immediately.';
