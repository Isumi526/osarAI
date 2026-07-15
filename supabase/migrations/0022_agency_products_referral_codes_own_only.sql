-- レビュー指摘の修正: agency_products / referral_codes の CUD ポリシーが
-- 「同組織のleaderなら誰でも」他leaderが作成した行もUPDATE/DELETEできてしまっていた
-- (using句にcreated_by=auth.uid()が無く、DELETEはwith checkの対象外のため素通りしていた)。
-- 作成者本人のみCUD可能に締める(閲覧は引き続き同組織全員に開放)。
drop policy agency_products_cud on agency_products;
create policy agency_products_cud on agency_products for all
  using (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid())
  with check (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid());

drop policy referral_codes_cud on referral_codes;
create policy referral_codes_cud on referral_codes for all
  using (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid())
  with check (org_id = current_org_id() and current_user_role() = 'leader' and created_by = auth.uid());
