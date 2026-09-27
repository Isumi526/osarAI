import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './hooks/useSession.js';
import { registerPushIfGranted } from './lib/push.js';
import { Login } from './screens/Login.js';
import { Home } from './screens/Home.js';
import { Osarai } from './screens/Osarai.js';
import { AssistantChat } from './screens/AssistantChat.js';
import { Tutorial } from './screens/Tutorial.js';
import { Tasks } from './screens/Tasks.js';
import { Notifications } from './screens/Notifications.js';
import { CustomerList } from './screens/CustomerList.js';
import { CustomerDetail } from './screens/CustomerDetail.js';
import { CustomerForm } from './screens/CustomerForm.js';
import { AiChat } from './screens/AiChat.js';
import { Settings } from './screens/Settings.js';
import { SchedulePage } from './screens/Schedule.js';
import { SelfOsarai } from './screens/SelfOsarai.js';
import { Welcome } from './screens/Welcome.js';
import { MeetingRecord } from './screens/MeetingRecord.js';
import { MeetingList } from './screens/MeetingList.js';
import { MeetingDetail } from './screens/MeetingDetail.js';
import { BottomNav, BOTTOM_NAV_HEIGHT, NAV_OVERHANG, useBottomNavVisible } from './components/BottomNav.js';
import { NavGuardProvider } from './components/NavGuard.js';
import { MeetingSessionProvider } from './components/MeetingSession.js';
import { useIsDesktop } from './hooks/useIsDesktop.js';

function AppRoutes() {
  const navVisible = useBottomNavVisible();
  const isDesktop = useIsDesktop();
  return (
    <NavGuardProvider>
      {/* 会議録音のレコーダーはアプリ全体で常駐（画面を移動しても録音が続く・T7c） */}
      <MeetingSessionProvider>
      <div style={{ paddingBottom: navVisible && !isDesktop ? BOTTOM_NAV_HEIGHT + NAV_OVERHANG : 0 }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/osarai" element={<Osarai />} />
          <Route path="/customers" element={<CustomerList />} />
          <Route path="/customers/new" element={<CustomerForm />} />
          <Route path="/customers/:id/edit" element={<CustomerForm />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/chat" element={<AssistantChat />} />
          <Route path="/meeting" element={<MeetingRecord />} />
          <Route path="/meetings" element={<MeetingList />} />
          <Route path="/meetings/:id" element={<MeetingDetail />} />
          <Route path="/chat/legacy" element={<AiChat />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/tutorial" element={<Tutorial />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/self-osarai" element={<SelfOsarai />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {navVisible && <BottomNav />}
      </MeetingSessionProvider>
    </NavGuardProvider>
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
