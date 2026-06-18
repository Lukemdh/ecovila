-- ADR-056: Angela CRM least-privilege (read-only dashboard).
--
-- Angela operates the daily ("Situația zilnică") and towels tabs and views a
-- read-only dashboard. The dashboard's write actions (add reservation, drag-to-
-- swap rooms, cancel) are direct writes on public.reservations, while the
-- financial actions (mark cash paid, refunds, confirmation SMS/email) already
-- run through edge functions that require role 'diana'.
--
-- Until now a single "CRM staff can manage reservations" policy let both diana
-- and angela do everything on the table. This migration removes Angela's
-- table-level write access to reservations while preserving the exact column
-- writes the daily tab performs (towel cards on check-in, plus the guest-count
-- / stay-extension edit). Diana keeps full management. Edge functions use the
-- service role and bypass RLS, so they are unaffected. crm_daily_statuses and
-- crm_towel_counts keep their existing both-roles "manage" policies.

-- 1. Replace the shared "manage" policy with explicit per-role policies.
drop policy if exists "CRM staff can manage reservations" on public.reservations;

drop policy if exists "Diana can manage reservations" on public.reservations;
create policy "Diana can manage reservations"
  on public.reservations
  for all
  to authenticated
  using (public.ecovila_app_role() = 'diana')
  with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read reservations" on public.reservations;
create policy "Angela can read reservations"
  on public.reservations
  for select
  to authenticated
  using (public.ecovila_app_role() = 'angela');

-- Angela may UPDATE reservations, but the column guard below restricts her to
-- the daily-tab fields. No INSERT or DELETE policy is granted to her, so adding
-- a reservation and hard-deleting one are denied outright by RLS.
drop policy if exists "Angela can update daily reservation fields" on public.reservations;
create policy "Angela can update daily reservation fields"
  on public.reservations
  for update
  to authenticated
  using (public.ecovila_app_role() = 'angela')
  with check (public.ecovila_app_role() = 'angela');

-- 2. Column-level guard for Angela's UPDATEs. RLS cannot compare OLD vs NEW per
-- column, so this trigger rejects any changed column outside the daily-tab
-- allowlist. Diana and the service role (ecovila_app_role() <> 'angela') return
-- early and are never restricted. The allowlist mirrors admin/js/crm-daily.js:
--   * saveIssuedTowelCards (check-in)  -> towel_cards_issued
--   * saveDailyGuestEdit (guest edit)  -> adults, check_out, kids_ages,
--                                         total_price, towel_cards_issued
-- The default-deny shape means any future reservations column is blocked for
-- Angela until it is added here deliberately.
create or replace function public.enforce_angela_reservation_columns()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  allowed_columns constant text[] := array[
    'towel_cards_issued', 'adults', 'check_out', 'kids_ages', 'total_price'
  ];
  old_row jsonb;
  new_row jsonb;
  column_name text;
begin
  if public.ecovila_app_role() <> 'angela' then
    return new;
  end if;

  old_row := to_jsonb(old);
  new_row := to_jsonb(new);

  for column_name in select jsonb_object_keys(new_row) loop
    if not (column_name = any (allowed_columns))
      and (new_row -> column_name) is distinct from (old_row -> column_name) then
      raise exception
        'Angela may only update daily-status fields on reservations (blocked column: %)', column_name
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists enforce_angela_reservation_columns on public.reservations;
create trigger enforce_angela_reservation_columns
  before update on public.reservations
  for each row
  execute function public.enforce_angela_reservation_columns();
