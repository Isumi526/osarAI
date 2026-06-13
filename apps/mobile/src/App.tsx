import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './screens/Login.js';
import { Home } from './screens/Home.js';
import { Osarai } from './screens/Osarai.js';
import { CustomerDetail } from './screens/CustomerDetail.js';
import { AiChat } from './screens/AiChat.js';
import { Settings } from './screens/Settings.js';

// フェーズ1: ルーティングの骨組みのみ。認証ガード・実画面はフェーズ3以降。
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
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
