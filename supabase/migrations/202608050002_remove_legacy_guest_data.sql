-- The private CSV is now authoritative. Remove disabled pre-import groups and
-- legacy planning fields that are not part of the anonymous RSVP model.

do $$
begin
  if exists (
    select 1
    from public.guests as guest
    join public.invites as invitation on invitation.id = guest.invite_id
    where invitation.access_enabled
      and guest.expected_name is not null
  ) then
    raise exception 'ACTIVE_GROUP_HAS_LEGACY_EXPECTED_NAME';
  end if;
end;
$$;

-- guests rows are removed by the existing ON DELETE CASCADE foreign key.
delete from public.invites
where not access_enabled;

alter table public.guests
  drop column expected_name;

alter table public.invites
  drop column party_name;

comment on table public.invites is
  'Guest groups enabled from the private digest-only import. No plaintext code or guest-list name is stored.';
comment on table public.guests is
  'One anonymous RSVP slot per enabled guest group seat; populated only with visitor-submitted data.';
