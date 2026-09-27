// 登録チャネル（販路）の定義。LP/signup の `?code=<チャネルコード>` は Stripe の割引コード
// （Promotion Code）でなくても profiles.channel_code に記録される（migration 0019 の handle_new_user）。
// ここには「割引なし・流入元の記録だけ」のチャネルを登録し、/subscribe で
// 「割引コードが無効です」と誤って赤表示しないようにする（2026-09-13）。
// 割引付きのコード（例: LL2026）は Stripe 側の Promotion Code が正で、ここには書かない。
// 登録者数の集計は /dashboard/referral-codes（referral_codes に同じコードを登録すると件数が出る）。
export interface ChannelDef {
  /** 表示名（/subscribe の案内文に使う） */
  label: string;
}

export const CHANNEL_CODES: Record<string, ChannelDef> = {
  LL: { label: 'リベラルライフ' },
};

/** コード文字列（大文字小文字を無視）から既知チャネルを引く。未知なら null。 */
export function channelDef(code: string | null | undefined): (ChannelDef & { code: string }) | null {
  if (!code) return null;
  const key = Object.keys(CHANNEL_CODES).find((k) => k.toLowerCase() === code.trim().toLowerCase());
  return key ? { code: key, ...CHANNEL_CODES[key]! } : null;
}
