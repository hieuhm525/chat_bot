import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type ReactElement } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import {
  Bot,
  Building2,
  ChevronsUpDown,
  Cpu,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Radio,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Loading } from '@/components/page';
import { BootErrorPage, ForbiddenPage, NotFoundPage, RouteErrorBoundary } from '@/components/error-pages';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { initials, ROLE_LABEL } from '@/lib/user';
import { api, ApiError, currentArea, safeNextPath } from './api';
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
const AuditLog = lazy(() => import('./routes/admin/audit').then((m) => ({ default: m.AuditLog })));
const Account = lazy(() => import('./routes/shared/account').then((m) => ({ default: m.Account })));

export interface User {
  id: string;
  username: string;
  role: string;
}

type Boot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; user: User | null; setup: SetupStatus | null };

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

const area: 'admin' | 'app' = currentArea() === '/app' ? 'app' : 'admin';

/** Resolves who is logged in. A 401 means "nobody"; any other failure is a real error the user must see. */
async function loadBoot(): Promise<Boot> {
  try {
    const setup = await api<SetupStatus>('/setup/status');
    if (setup.needsSetup) return { state: 'ready', user: null, setup };
    try {
      const user = await api<User>('/auth/me', { redirectOn401: false });
      return { state: 'ready', user, setup: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return { state: 'ready', user: null, setup: null };
      throw err;
    }
  } catch (err) {
    console.error('Khởi động ứng dụng thất bại: không đọc được /setup/status hoặc /auth/me', err);
    const message = err instanceof Error ? err.message : 'Không rõ nguyên nhân';
    return { state: 'error', message: `${message}. Kiểm tra kết nối mạng hoặc thử lại sau ít phút.` };
  }
}

function UserMenu({ user, onLogout, compact }: { user: User; onLogout: () => void; compact?: boolean }) {
  const role = ROLE_LABEL[user.role] ?? user.role;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Menu tài khoản ${user.username}`}>
            <Avatar className="size-8">
              <AvatarFallback className="text-xs font-semibold">{initials(user.username)}</AvatarFallback>
            </Avatar>
          </Button>
        ) : (
          <button className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent">
            <Avatar className="size-8">
              <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
                {initials(user.username)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium text-sidebar-accent-foreground">{user.username}</div>
              <div className="text-xs text-sidebar-foreground/70">{role}</div>
            </div>
            <ChevronsUpDown className="size-4 text-sidebar-foreground/70" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={compact ? 'bottom' : 'top'} className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{user.username}</div>
          <div className="text-xs text-muted-foreground">{role}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserRound />
            Tài khoản
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout}>
          <LogOut />
          Đăng xuất
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Rendered at /login once signed in: continue to `?next=` (same-area paths only) or home. */
function AfterLogin() {
  const [params] = useSearchParams();
  return <Navigate to={safeNextPath(params.get('next'))} replace />;
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
        bv
      </span>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-sidebar-accent-foreground">bv-agent-msg</div>
        <div className="text-xs text-sidebar-foreground/70">{area === 'admin' ? 'Quản trị hệ thống' : 'Workspace'}</div>
      </div>
    </div>
  );
}

function NavLinks({ links, onNavigate }: { links: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Điều hướng chính" className="flex flex-col gap-1 px-3">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:no-underline',
              isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  const start = useCallback(() => {
    setBoot({ state: 'loading' });
    loadBoot().then(setBoot);
  }, []);
  useEffect(start, [start]);

  const ready = boot.state === 'ready' ? boot : null;
  const user = ready?.user ?? null;
  const isAdmin = user?.role === 'admin';
  const isOwner = user?.role === 'owner';
  const signedIn = (u: User) => setBoot({ state: 'ready', user: u, setup: null });

  // Each area is a separate basename, so cross-area moves need a full load.
  useEffect(() => {
    if (!ready) return;
    if (ready.setup?.needsSetup) {
      if (area === 'app') window.location.replace('/admin/setup');
      return;
    }
    if (!user) return;
    if (isAdmin && area === 'app') window.location.replace('/admin');
    if (!isAdmin && area === 'admin') window.location.replace('/app');
  }, [ready, user, isAdmin]);

  if (boot.state === 'loading') return <Loading />;
  if (boot.state === 'error') return <BootErrorPage message={boot.message} onRetry={start} />;

  if (boot.setup?.needsSetup) {
    if (area === 'app') return <Loading label="Đang chuyển…" />;
    return (
      <Routes>
        <Route path="/setup" element={<Setup status={boot.setup} onDone={signedIn} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!user) {
    const here = location.pathname + location.search;
    const loginTarget = here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`;
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={signedIn} />} />
        {area === 'app' && <Route path="/register" element={<Register onLogin={signedIn} />} />}
        <Route path="*" element={<Navigate to={loginTarget} replace />} />
      </Routes>
    );
  }

  if ((area === 'admin') !== isAdmin) return <Loading label="Đang chuyển…" />;

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', redirectOn401: false });
    } catch (err) {
      // An expired session is already logged out; anything else must be shown.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast.error(`Không đăng xuất được: ${err instanceof Error ? err.message : 'lỗi không rõ'}`);
        return;
      }
    }
    setBoot({ state: 'ready', user: null, setup: null });
  };

  const links: NavItem[] =
    area === 'admin'
      ? [
          { to: '/', label: 'Tenant', icon: Building2, end: true },
          { to: '/providers', label: 'AI provider', icon: Cpu },
          { to: '/audit', label: 'Nhật ký thao tác', icon: History },
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

  const ownerOnly = (el: ReactElement) => (isOwner ? el : <ForbiddenPage />);

  return (
    <div className="flex h-dvh flex-col md:h-auto md:min-h-screen md:flex-row">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground no-underline focus:not-sr-only focus:fixed focus:top-3 focus:left-3 hover:no-underline"
      >
        Bỏ qua tới nội dung chính
      </a>
      {/* Mobile: top bar with a drawer for navigation. */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b bg-sidebar px-3 py-2 text-sidebar-foreground md:hidden">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => setDrawerOpen(true)}
            aria-label="Mở menu điều hướng"
          >
            <Menu />
          </Button>
          <Brand />
        </div>
        <UserMenu user={user} onLogout={logout} compact />
      </header>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-72 gap-2 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
          <SheetHeader className="px-5 py-4">
            <SheetTitle className="sr-only">Điều hướng</SheetTitle>
            <SheetDescription className="sr-only">Chọn trang cần mở</SheetDescription>
            <Brand />
          </SheetHeader>
          <NavLinks links={links} onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Desktop: fixed sidebar with the account menu at the bottom. */}
      <aside className="hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-screen md:w-60">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <NavLinks links={links} />
        <div className="mt-auto border-t border-sidebar-border p-3">
          <UserMenu user={user} onLogout={logout} />
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none md:overflow-visible">
        <RouteErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<Loading />}>
            {area === 'admin' ? (
              <Routes>
                <Route path="/" element={<Tenants />} />
                <Route path="/providers" element={<Providers />} />
                <Route path="/audit" element={<AuditLog />} />
                <Route path="/account" element={<Account user={user} />} />
                <Route path="/login" element={<AfterLogin />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            ) : (
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/channels" element={ownerOnly(<Channels />)} />
                <Route path="/bots" element={ownerOnly(<Bots />)} />
                <Route path="/bots/:botId" element={ownerOnly(<BotDetail />)} />
                <Route path="/bots/:botId/import" element={ownerOnly(<RuleImport />)} />
                <Route path="/account" element={<Account user={user} />} />
                <Route path="/login" element={<AfterLogin />} />
                <Route path="/register" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            )}
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
