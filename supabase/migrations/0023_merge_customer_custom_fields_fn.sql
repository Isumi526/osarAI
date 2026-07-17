-- おさらい対話が複数ターンにまたがった場合、既存顧客(customers)へのcustom_fields反映が
-- 完全上書き(というより実際は未反映)になり、前ターンで判明済みの項目が消える/保存されない
-- バグの修正。0013のmerge_user_profile_fieldsと同じアトミックなjsonbマージパターンを
-- customers.custom_fieldsにも適用する。
-- security invokerによりRLS(customers_cud: owner_id=auth.uid())で他人の顧客への書き込みは
-- 実効的にブロックされるが、多層防御としてWHERE句にもowner_id=auth.uid()を明示する。
create or replace function merge_customer_custom_fields(target_customer_id uuid, new_fields jsonb) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update customers
  set custom_fields = coalesce(custom_fields, '{}'::jsonb) || coalesce(new_fields, '{}'::jsonb)
  where id = target_customer_id and owner_id = auth.uid();
$$;
