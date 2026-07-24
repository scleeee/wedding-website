# RSVP invitation data

`invites` contains one row per physical invitation. `guests` contains one row
per reserved seat. The browser cannot read either table directly; it can only
use `lookup_rsvp` and `submit_rsvp` with the invitation's random access code.

## Create one invitation

Run this as an administrator in the Supabase SQL editor, replacing only the
clearly marked placeholders. Keep the transaction intact so an invitation can
never be created without all of its reserved seats.

```sql
begin;

with new_invite as (
  insert into public.invites (party_name, num_seats, rsvp_deadline)
  values ('<PARTY LABEL>', 2, null)
  returning id, code
), new_seats as (
  insert into public.guests (invite_id, seat_number, expected_name)
  select new_invite.id, seat.seat_number, seat.expected_name
  from new_invite
  cross join (
    values
      (1, '<KNOWN GUEST NAME>'::text),
      (2, null::text) -- unnamed partner/guest seat
  ) as seat(seat_number, expected_name)
  returning invite_id
)
select code as code_to_print_on_invitation from new_invite;

commit;
```

The `code` column defaults to a unique 30-character, 120-bit random code. It is
safe to print the code with spaces or hyphens for readability; the public lookup
ignores those separators. Do not replace it with a family name, surname, date,
or other guessable value.

For a known guest, put the invitation name in `expected_name`. For an unnamed
partner or guest seat, use `null`. Do not prefill the response-only `name`,
`attending`, or `dietary_requirements` columns.

## Bulk import

Import invitations first, omitting `id` and `code` so Supabase generates them.
Export the resulting `id`, `code`, and `party_name` values to prepare physical
invitations. Then import exactly `num_seats` guest rows for each invitation with
these columns:

- `invite_id`
- `seat_number` (starting at 1 and unique within the invitation)
- `expected_name` (blank for an editable partner/guest seat)

Keep the generated codes out of source control and public spreadsheets. A code
is the shared credential for one party.

## Deadline and closure

`rsvp_deadline` is optional and remains unset until the real deadline is known.
`rsvp_closed` can close an invitation immediately. A closed invitation can still
view its saved response, but the submit RPC rejects changes.
