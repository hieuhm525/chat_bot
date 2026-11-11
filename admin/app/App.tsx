import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Login } from './routes/login';
import { Register } from './routes/register';
import { Setup, SetupStatus } from './routes/setup';
import { Dashboard } from './routes/dashboard';
import { Conversations } from './routes/conversations';
import { Channels } from './routes/channels';
import { Bots } from './routes/bot';
import { BotDetail } from './routes/bot-detail';
import { Members } from './routes/members';
import { Tenants } from './routes/tenants';
import { Providers } from './routes/providers';

export interface User {
  id: string;
  username: string;
  role: string;
}

interface Boot {
  user: User | null;
  setup: SetupStatus | null;
}

const area: 'admin' | 'app' = window.location.pathname.startsWith('/app') ? 'app' : 'admin';

export function App() {
  const [boot, setBoot] = useState<Boot | undefined>(undefined);

  useEffect(() => {
    (async () => {
      try {
        const setup = await api<SetupStatus>('/setup/status');
        if (setup.needsSetup) {
          setBoot({ user: null, setup });
          return;
        }
        const user = await api<User>('/auth/me').catch(() => null);
        setBoot({ user, setup: null });
      } catch {
        setBoot({ user: null, setup: null });
      }
    })();
  }, []);

  const user = boot?.user ?? null;
  const isAdmin = user?.role === 'admin';
  const isOwner = user?.role === 'owner';

  // Each area is a separate basename, so cross-area moves need a full load.
  useEffect(() => {
    if (!boot) return;
    if (boot.setup?.needsSetup) {
      if (area === 'app') window.location.replace('/admin/setup');
      return;
    }
    if (!user) return;
    if (isAdmin && area === 'app') window.location.replace('/admin');
    if (!isAdmin && area === 'admin') window.location.replace('/app');
  }, [boot, user, isAdmin]);

  if (!boot) return <p className="muted pad">Đang tải…</p>;

  if (boot.setup?.needsSetup) {
    if (area === 'app') return <p className="muted pad">Đang chuyển…</p>;
    return (
      <Routes>
        <Route
          path="/setup"
          element={<Setup status={boot.setup} onDone={(u) => setBoot({ user: u, setup: null })} />}
        />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={(u) => setBoot({ user: u, setup: null })} />} />
        {area === 'app' && (
          <Route path="/register" element={<Register onLogin={(u) => setBoot({ user: u, setup: null })} />} />
        )}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if ((area === 'admin') !== isAdmin) return <p className="muted pad">Đang chuyển…</p>;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setBoot({ user: null, setup: null });
  };

  return (
    <div className="layout">
      <aside>
        <div className="brand">bv-agent-msg</div>
        <nav>
          {area === 'admin' ? (
            <>
              <NavLink to="/" end>
                Tenant
              </NavLink>
              <NavLink to="/providers">AI provider</NavLink>
            </>
          ) : (
            <>
              <NavLink to="/" end>
                Dashboard
              </NavLink>
              <NavLink to="/conversations">Hội thoại</NavLink>
              {isOwner && (
                <>
                  <NavLink to="/channels">Kênh</NavLink>
                  <NavLink to="/bots">AI agent</NavLink>
                  <NavLink to="/members">Thành viên</NavLink>
                </>
              )}
            </>
          )}
        </nav>
        <div className="who">
          <div>{user.username}</div>
          <button className="link" onClick={logout}>
            Đăng xuất
          </button>
        </div>
      </aside>
      <main>
        {area === 'admin' ? (
          <Routes>
            <Route path="/" element={<Tenants />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/conversations" element={<Conversations />} />
            {isOwner && <Route path="/channels" element={<Channels />} />}
            {isOwner && <Route path="/bots" element={<Bots />} />}
            {isOwner && <Route path="/bots/:botId" element={<BotDetail />} />}
            {isOwner && <Route path="/members" element={<Members />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
