import { Navigate, Route, Routes } from 'react-router';

import { Layout } from './components/Layout';
import { ChooseOrganizationPage } from './pages/ChooseOrganizationPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { useSession } from './session/session';

/** The pages follow the session: login, choice of the organization, then the dashboard. */
export function App() {
  const { state } = useSession();

  if (state.status === 'loading') {
    return (
      <main className="auth" aria-busy="true">
        <p className="muted">Caricamento…</p>
      </main>
    );
  }
  if (state.status === 'anonymous') return <LoginPage notice={state.notice} />;
  if (state.status === 'choosing') {
    return <ChooseOrganizationPage organizations={state.organizations} />;
  }

  const { me } = state;
  return (
    <Routes>
      <Route element={<Layout me={me} />}>
        <Route index element={<HomePage me={me} />} />
        <Route path="profilo" element={<ProfilePage me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
