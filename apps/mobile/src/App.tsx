import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './hooks/useSession.js';
import { Login } from './screens/Login.js';
import { Home } from './screens/Home.js';
import { Osarai } from './screens/Osarai.js';
import { CustomerDetail } from './screens/CustomerDetail.js';
import { AiChat } from './screens/AiChat.js';
import { Settings } from './screens/Settings.js';

// 認証ガード：未ログインは Login のみ、ログイン済みは各画面へ。
export function App() {
  const { session, loading } = useSession();

  if (loading) {
    return <main className="screen">読み込み中…</main>;
  }

  if (!session) {
    return <Login />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/osarai" element={<Osarai />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/chat" element={<AiChat />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
