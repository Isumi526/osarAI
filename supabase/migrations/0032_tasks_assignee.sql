-- タスクの「誰が引き受けたか」（2026-09-27・人判断: 相手の約束を「相手待ち」として残す）。
-- 会議の文字起こしから、相手が「確認してご連絡します」「資料を送ります」と引き受けたことも
-- タスクとして登録し、自分のタスクとは分けて表示する（返事が来ていないことに気づけるように）。
-- self  = 自分がやること（従来のタスク）
-- other = 相手がやること＝自分は待っている（相手待ち）
alter table tasks
  add column assignee text not null default 'self' check (assignee in ('self', 'other'));

comment on column tasks.assignee is 'self=自分がやる / other=相手がやる（相手待ち）';
