-- 予定にカテゴリを追加（議事録『review』要望）。汎用の固定リスト+自由記述を許容し、
-- 選択肢の増減が業務判断になるためCHECK制約は設けない（テキストのまま保存）。
alter table schedules add column category text;
