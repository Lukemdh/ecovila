set search_path = public, extensions;

drop policy if exists "maib_payments_no_client_access" on public.maib_payments;

create policy "maib_payments_no_client_access"
  on public.maib_payments
  for all
  to anon, authenticated
  using (false)
  with check (false);
