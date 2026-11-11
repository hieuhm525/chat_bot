import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Bot, Building2, Cpu, LayoutDashboard, LogOut, MessagesSquare, Radio } from 'lucide-react';
import { Loading } from '@/components/page';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from './api';
import { Login } from './routes/auth/login';
import { Register } from './routes/auth/register';
import { Setup, SetupStatus } from './routes/auth/setup';

// Each area only downloads its own screens; admin pages never ship to shop owners and vice versa.
const Dashboard = lazy(() => import('./routes/app/dashboard').then((m) => ({ default: m.Dashboard })));
const Conversations = lazy(() => import('./routes/app/conversations').then((m) => ({ default: m.Conversations })));
const Channels = lazy(() => import('./routes/app/channels').then((m) => ({ default: m.Channels })));
const Bots = lazy(() => import('./routes/app/bots').then((m) => ({ default: m.Bots })));
const BotDetail = lazy(() => import('./routes/app/bot-detail').then((m) => ({ default: m.BotDetail })));
const RuleImport = lazy(() => import('./routes/app/rule-import').then((m) => ({ default: m.RuleImport })));
const Tenants = lazy(() => import('./routes/admin/tenants').then((m) => ({ default: m.Tenants })));
const Providers = lazy(() => import('./routes/admin/providers').then((m) => ({ default: m.Providers })));

export interface User {
  id: string;
  username: string;
  role: string;
}

interface Boot {
  user: User | null;
  setup: SetupStatus | null;
}

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

const ROLE_LABEL: Record<string, string> = { admin: 'Quản trị', owner: 'Chủ shop' };

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

  if (!boot) return <Loading />;

  if (boot.setup?.needsSetup) {
    if (area === 'app') return <Loading label="Đang chuyển…" />;
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

  if ((area === 'admin') !== isAdmin) return <Loading label="Đang chuyển…" />;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setBoot({ user: null, setup: null });
  };

  const links: NavItem[] =
    area === 'admin'
      ? [
          { to: '/', label: 'Tenant', icon: Building2, end: true },
          { to: '/providers', label: 'AI provider', icon: Cpu },
        ]
      : [
          { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
          { to: '/conversations', label: 'Hội thoại', icon: MessagesSquare },
          ...(isOwner
            ? [
                { to: '/channels', label: 'Kênh', icon: Radio },
                { to: '/bots', label: 'AI agent', icon: Bot },
              ]
            : []),
        ];

  return (
    <div className="flex h-dvh flex-col md:h-auto md:min-h-screen md:flex-row">
      <aside className="flex shrink-0 flex-col bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-60">
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-3 md:py-5">
          <span className="grid size-8 place-items-center rounded-lg bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
            bv
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-sidebar-accent-foreground">bv-agent-msg</div>
            <div className="text-xs text-sidebar-foreground/70">{area === 'admin' ? 'Quản trị hệ thống' : 'Workspace'}</div>
          </div>
        </div>
        <nav aria-label="Điều hướng chính" className="flex flex-wrap gap-1 px-3 pb-3 md:flex-col md:flex-nowrap md:pb-0">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:no-underline',
                  isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
          <button
            onClick={logout}
            className="flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent md:hidden"
          >
            <LogOut className="size-4" />
            Đăng xuất
          </button>
        </nav>
        <div className="mt-auto hidden border-t border-sidebar-border p-3 md:block">
          <div className="flex items-center gap-3 rounded-md px-2 py-2">
            <span className="grid size-8 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold uppercase text-sidebar-accent-foreground">
              {user.username.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium text-sidebar-accent-foreground">{user.username}</div>
              <div className="text-xs text-sidebar-foreground/70">{ROLE_LABEL[user.role] ?? user.role}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={logout}
              title="Đăng xuất" aria-label="Đăng xuất"
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto md:overflow-visible">
        <Suspense fallback={<Loading />}>
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
            {isOwner && <Route path="/bots/:botId/import" element={<RuleImport />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
        </Suspense>
      </main>
    </div>
  );
}
