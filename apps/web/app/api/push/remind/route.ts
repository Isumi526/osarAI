// おさらい促し通知の送信（§12）。習慣化の中核＝能動入力を受動回答に変える。
// MVP: 認証ユーザー本人の端末へ送る（実機での到達確認用）。
// 将来: cron から「予定/活動を入れた人／1日の終わり」に一括配信（要スケジューラ）。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { sendPush } from '@/lib/push-fcm';

export const runtime = 'nodejs';

const TITLE = 'おさらいしませんか？';
const BODY = '今日会った人、記憶が新しいうちに5分でおさらいしましょう。';

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: CORS_HEADERS });
  }
  const { supabase, user } = ctx;

  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('user_id', user.id);

  const tokenList = (tokens ?? []).map((t) => t.token);
  const result = await sendPush(tokenList, { title: TITLE, body: BODY, data: { screen: 'osarai' } });

  return NextResponse.json(
    { tokens: tokenList.length, ...result },
    { status: result.configured ? 200 : 501, headers: CORS_HEADERS },
  );
}
