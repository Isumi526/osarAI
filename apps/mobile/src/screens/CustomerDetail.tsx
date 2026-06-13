// CustomerDetail（カード＋タイムライン）— 実装はフェーズ5。
import { useParams } from 'react-router-dom';

export function CustomerDetail() {
  const { id } = useParams();
  return (
    <main className="screen">
      <h1>顧客詳細</h1>
      <p>顧客ID: {id}（カード＋タイムライン）。— フェーズ5で実装。</p>
    </main>
  );
}
