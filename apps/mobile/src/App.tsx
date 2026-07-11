import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './hooks/useSession.js';
import { registerPushIfGranted } from './lib/push.js';
import { Login } from './screens/Login.js';
import { Home } from './screens/Home.js';
import { Osarai } from './screens/Osarai.js';
import { CustomerDetail } from './screens/CustomerDetail.js';
import { CustomerForm } from './screens/CustomerForm.js';
import { AiChat } from './screens/AiChat.js';
import { Settings } from './screens/Settings.js';
import { SchedulePage } from './screens/Schedule.js';
import { SelfOsarai } from './screens/SelfOsarai.js';
import { Welcome } from './screens/Welcome.js';
import { BottomNav, BOTTOM_NAV_HEIGHT, useBottomNavVisible } from './components/BottomNav.js';

function AppRoutes() {
  const navVisible = useBottomNavVisible();
  return (
    <>
      <div style={{ paddingBottom: navVisible ? BOTTOM_NAV_HEIGHT : 0 }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/osarai" element={<Osarai />} />
          <Route path="/customers/new" element={<CustomerForm />} />
          <Route path="/customers/:id/edit" element={<CustomerForm />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/chat" element={<AiChat />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/self-osarai" element={<SelfOsarai />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <BottomNav />
    </>
  );
}

// 認証ガード：未ログインは Login のみ、ログイン済みは各画面へ。
export function App() {
  const { session, loading } = useSession();

  // ログイン済みなら（許可済みの端末で）プッシュトークンを再登録
  useEffect(() => {
    if (session) void registerPushIfGranted();
  }, [session]);

  if (loading) {
    return <main className="screen">読み込み中…</main>;
  }

  if (!session) {
    return <Login />;
  }

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
