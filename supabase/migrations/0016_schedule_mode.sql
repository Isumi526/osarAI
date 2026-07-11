-- 予定に対面/オンラインの区分を追加(議事録要望)。値の選択肢が今後増える可能性を
-- 考慮しCHECK制約は設けず自由記述(text)にする(category列と同じ方針)。
alter table schedules add column mode text;
