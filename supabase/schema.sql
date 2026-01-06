create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_code text unique not null,
  user_id uuid null,
  customer_name text null,
  customer_email text null,
  route_area text null,
  service_type text null,
  vehicle_type text null,
  price_before_tax numeric not null,
  currency text not null default 'CAD',
  status text not null default 'Scheduled',
  payment_status text not null default 'unpaid',
  stripe_session_id text null,
  stripe_payment_intent_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_events (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null,
  note text null,
  at timestamptz not null default now()
);

alter table public.orders enable row level security;
alter table public.order_events enable row level security;

-- Orders: logged-in users can manage their own
create policy "orders_select_own" on public.orders
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "orders_insert_own" on public.orders
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "orders_update_own" on public.orders
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Order events: logged-in users can read events for their own orders
create policy "order_events_select_own" on public.order_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_events.order_id and o.user_id = auth.uid()
    )
  );

create policy "order_events_insert_own" on public.order_events
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.orders o
      where o.id = order_events.order_id and o.user_id = auth.uid()
    )
  );

 create table if not exists public.receipts (
   id uuid primary key default gen_random_uuid(),
   user_id uuid not null,
   order_code text null,
   text text not null,
   created_at timestamptz not null default now()
 );

 alter table public.receipts enable row level security;

 create policy "receipts_select_own" on public.receipts
   for select
   to authenticated
   using (user_id = auth.uid());

 create policy "receipts_insert_own" on public.receipts
   for insert
   to authenticated
   with check (user_id = auth.uid());

 create policy "receipts_delete_own" on public.receipts
   for delete
   to authenticated
   using (user_id = auth.uid());

alter table public.orders add column if not exists form_data jsonb null;
alter table public.orders add column if not exists documents jsonb null;

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'employee')),
  email text null,
  name text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.staff_profiles add column if not exists email text null;
alter table public.staff_profiles add column if not exists name text null;
alter table public.staff_profiles add column if not exists active boolean not null default true;

alter table public.staff_profiles enable row level security;

create policy "staff_profiles_select_own" on public.staff_profiles
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.is_staff_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_profiles
    where user_id = uid
      and role = 'admin'
      and active = true
  );
$$;

grant execute on function public.is_staff_admin(uuid) to authenticated;

create policy "staff_profiles_select_admin_v2" on public.staff_profiles
  for select
  to authenticated
  using (public.is_staff_admin(auth.uid()));

create policy "staff_profiles_update_admin_v2" on public.staff_profiles
  for update
  to authenticated
  using (public.is_staff_admin(auth.uid()))
  with check (public.is_staff_admin(auth.uid()));

create policy "staff_profiles_insert_admin_v2" on public.staff_profiles
  for insert
  to authenticated
  with check (public.is_staff_admin(auth.uid()));

create policy "staff_profiles_delete_admin_v2" on public.staff_profiles
  for delete
  to authenticated
  using (public.is_staff_admin(auth.uid()));

create policy "orders_select_staff" on public.orders
  for select
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "orders_update_staff" on public.orders
  for update
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "orders_delete_staff" on public.orders
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "order_events_select_staff" on public.order_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "order_events_insert_staff" on public.order_events
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create table if not exists public.billing_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text null,
  has_saved_payment_method boolean not null default false,
  card_brand text null,
  card_last4 text null,
  card_exp_month integer null,
  card_exp_year integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.billing_profiles enable row level security;

create policy "billing_profiles_select_own" on public.billing_profiles
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "billing_profiles_insert_own" on public.billing_profiles
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "billing_profiles_update_own" on public.billing_profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "billing_profiles_select_admin" on public.billing_profiles
  for select
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid() and sp.role = 'admin'
    )
  );
