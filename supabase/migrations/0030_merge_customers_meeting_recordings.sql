-- つながり統合（0027 merge_customers）に会議録音テーブル（0028 meeting_recordings）の付け替えを追加（T7）。
-- 0028 は 0027 の後に追加されたため、表記揺れ統合で統合元が delete されると
-- meeting_recordings.customer_id が on delete set null で失われていた。
-- 関数本体は 0027 と同一で、付け替え1行のみ追加（既存 migration は書き換えない）。
create or replace function merge_customers(source_id uuid, target_id uuid)
returns void
language plpgsql
security invoker  -- RLSを効かせる（自分のつながり同士でしか統合できない）
set search_path = public, pg_temp
as $$
declare
  src customers%rowtype;
  tgt customers%rowtype;
begin
  if source_id = target_id then
    raise exception '同じつながりは統合できません';
  end if;

  select * into src from customers where id = source_id;
  select * into tgt from customers where id = target_id;
  if src.id is null or tgt.id is null then
    raise exception '対象のつながりが見つかりません';
  end if;
  if src.owner_id <> tgt.owner_id or src.org_id <> tgt.org_id then
    raise exception '所有者または組織が異なるつながりは統合できません';
  end if;

  -- 統合先に情報を寄せる。統合先が空の項目だけ統合元で埋める（上書きしない）。
  update customers set
    needs = case
      when coalesce(tgt.needs, '') = '' then src.needs
      when coalesce(src.needs, '') = '' or tgt.needs = src.needs then tgt.needs
      else tgt.needs || ' / ' || src.needs
    end,
    custom_fields = coalesce(src.custom_fields, '{}'::jsonb) || coalesce(tgt.custom_fields, '{}'::jsonb),
    relation_type = coalesce(tgt.relation_type, src.relation_type),
    last_met_at = greatest(coalesce(tgt.last_met_at, src.last_met_at), coalesce(src.last_met_at, tgt.last_met_at)),
    updated_at = now()
  where id = target_id;

  -- customer_id を持つ全テーブルを付け替える（新しいテーブルを足したらここにも追加すること）
  update interactions    set customer_id = target_id where customer_id = source_id;
  update schedules       set customer_id = target_id where customer_id = source_id;
  update tasks           set customer_id = target_id where customer_id = source_id;
  update osarai_sessions set customer_id = target_id where customer_id = source_id;
  update ai_chats        set customer_id = target_id where customer_id = source_id;
  -- 会議録音（0028）。統合元が消えると on delete set null で相手リンクが失われるため付け替える。
  update meeting_recordings set customer_id = target_id where customer_id = source_id;

  delete from customers where id = source_id;
end;
$$;
