-- Accent- and case-insensitive staff reservation name search.
-- Powers the CRM "Caută rezervare" name field so "Ștefan" matches "Stefan" and
-- "Țurcanu" matches "turcanu". The function only returns reservation ids; the CRM
-- then re-selects the full rows through the existing RLS-guarded query, so no guest
-- data shape changes here.
--
-- SECURITY INVOKER (default): the function runs with the caller's privileges, so the
-- existing reservations RLS applies (only Diana/Angela may read). It does not need
-- elevated privileges, so it is not a security-definer RPC.

create extension if not exists unaccent with schema extensions;

create or replace function public.search_reservation_ids(search_name text)
returns table (id uuid)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select r.id
  from public.reservations r
  where search_name is not null
    and btrim(search_name) <> ''
    and (
      -- Every whitespace-separated token must appear in the first or last name,
      -- accent- and case-insensitively, so name order does not matter.
      select bool_and(
        extensions.unaccent(r.guest_first_name) ilike '%' || extensions.unaccent(token) || '%'
        or extensions.unaccent(r.guest_last_name) ilike '%' || extensions.unaccent(token) || '%'
      )
      from (
        select regexp_replace(raw_token, '[%_\\]', '', 'g') as token
        from regexp_split_to_table(btrim(search_name), '\s+') as raw_token
      ) tokens
      where btrim(token) <> ''
    );
$$;

comment on function public.search_reservation_ids(text) is
  'Returns reservation ids whose guest name matches every whitespace token in '
  'search_name, accent- and case-insensitively. SECURITY INVOKER so reservations '
  'RLS applies (staff-only reads).';

revoke execute on function public.search_reservation_ids(text) from public;
grant execute on function public.search_reservation_ids(text) to authenticated;
