import { Navigate, Route, Routes, useLocation } from 'react-router';

import { Layout } from './components/Layout';
import { ActivityPage, AssistantUsagePage } from './pages/ActivityPage';
import { ChooseOrganizationPage } from './pages/ChooseOrganizationPage';
import { DeadlinesPage } from './pages/DeadlinesPage';
import { ExportPage } from './pages/ExportPage';
import { HomePage } from './pages/HomePage';
import { InvitationPage } from './pages/InvitationPage';
import { LoginPage } from './pages/LoginPage';
import { NewPracticePage } from './pages/NewPracticePage';
import { PeoplePage } from './pages/PeoplePage';
import { PracticeDetailPage } from './pages/PracticeDetailPage';
import { PracticesPage } from './pages/PracticesPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { useSession } from './session/session';

/** The pages follow the session: login, choice of the organization, then the dashboard. */
export function App() {
  const { state } = useSession();
  const { pathname } = useLocation();

  if (state.status === 'loading') {
    return (
      <main className="auth" aria-busy="true">
        <p className="muted">Caricamento…</p>
      </main>
    );
  }
  // The link of an invitation email works whether or not someone is logged in (P9).
  if (pathname === '/invito') return <InvitationPage />;
  if (state.status === 'anonymous') return <LoginPage notice={state.notice} />;
  if (state.status === 'choosing') {
    return <ChooseOrganizationPage organizations={state.organizations} />;
  }

  const { me } = state;
  return (
    <Routes>
      <Route element={<Layout me={me} />}>
        <Route index element={<HomePage me={me} />} />
        <Route path="pratiche" element={<PracticesPage me={me} />} />
        <Route path="pratiche/nuova" element={<NewPracticePage />} />
        <Route path="pratiche/:id" element={<PracticeDetailPage me={me} />} />
        <Route path="scadenze" element={<DeadlinesPage me={me} />} />
        <Route path="export" element={<ExportPage me={me} />} />
        <Route path="persone" element={<PeoplePage me={me} />} />
        <Route path="attivita" element={<ActivityPage me={me} />} />
        <Route path="attivita/assistente" element={<AssistantUsagePage me={me} />} />
        <Route path="impostazioni" element={<SettingsPage me={me} />} />
        <Route path="profilo" element={<ProfilePage me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
