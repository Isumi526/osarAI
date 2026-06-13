// Home（今日のおさらい促し＋顧客リスト）— 実装はフェーズ5。
import { Link } from 'react-router-dom';

export function Home() {
  return (
    <main className="screen">
      <h1>osarAI 〜おさらい〜</h1>
      <p>忙しくても、人を大切にできる自分に。</p>
      <nav style={{ display: 'grid', gap: 8, marginTop: 16 }}>
        <Link to="/osarai">おさらいする</Link>
        <Link to="/chat">AIに相談する</Link>
        <Link to="/settings">設定</Link>
      </nav>
    </main>
  );
}
