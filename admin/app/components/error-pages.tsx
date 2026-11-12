import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, RotateCw, SearchX, ServerCrash, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/hooks/use-document-title';

function ErrorScreen(props: {
  icon: ReactNode;
  code?: string;
  title: string;
  description: ReactNode;
  actions: ReactNode;
}) {
  useDocumentTitle(props.title);
  return (
    <div className="grid min-h-[60vh] place-items-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">{props.icon}</div>
        {props.code && <p className="text-sm font-medium text-muted-foreground">Lỗi {props.code}</p>}
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        <p className="text-sm text-muted-foreground">{props.description}</p>
        <div className="flex flex-wrap justify-center gap-2">{props.actions}</div>
      </div>
    </div>
  );
}

function BackAndHome() {
  const navigate = useNavigate();
  return (
    <>
      <Button variant="outline" onClick={() => navigate(-1)}>
        <ArrowLeft />
        Quay lại
      </Button>
      <Button asChild>
        <Link to="/">
          <Home />
          Về trang chủ
        </Link>
      </Button>
    </>
  );
}

/** A page whose data failed to load (not found, network, 500): say why and give a way out, not a bare alert. */
export function LoadErrorPage({ message }: { message: string }) {
  return (
    <ErrorScreen
      icon={<ServerCrash className="size-6" />}
      title="Không tải được trang"
      description={message}
      actions={
        <>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCw />
            Thử lại
          </Button>
          <BackAndHome />
        </>
      }
    />
  );
}

export function NotFoundPage() {
  return (
    <ErrorScreen
      icon={<SearchX className="size-6" />}
      code="404"
      title="Không tìm thấy trang"
      description="Đường dẫn này không tồn tại hoặc đã bị đổi. Kiểm tra lại địa chỉ, hoặc quay về trang chủ."
      actions={<BackAndHome />}
    />
  );
}

export function ForbiddenPage() {
  return (
    <ErrorScreen
      icon={<ShieldX className="size-6" />}
      code="403"
      title="Bạn không có quyền xem trang này"
      description="Tài khoản của bạn không được phép truy cập mục này. Nếu cần quyền, hãy liên hệ quản trị viên."
      actions={<BackAndHome />}
    />
  );
}

/** Shown when the app cannot even start (server down, network lost) — not the same as "not logged in". */
export function BootErrorPage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <ErrorScreen
      icon={<ServerCrash className="size-6" />}
      title="Không tải được ứng dụng"
      description={message}
      actions={
        <Button onClick={onRetry}>
          <RotateCw />
          Thử lại
        </Button>
      }
    />
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** Changing this (e.g. the current path) clears a caught error so navigation recovers. */
  resetKey?: string;
}

interface BoundaryState {
  error: Error | null;
}

/** Catches render errors below it so one broken screen never blanks the whole app. */
export class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Màn hình bị lỗi khi hiển thị', { path: window.location.pathname, error, componentStack: info.componentStack });
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CrashScreen message={this.state.error.message} onRetry={() => this.setState({ error: null })} />
    );
  }
}

function CrashScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <ErrorScreen
      icon={<ServerCrash className="size-6" />}
      code="500"
      title="Màn hình này gặp lỗi"
      description={
        <>
          Đã có lỗi khi hiển thị trang. Thử lại, hoặc về trang chủ rồi mở lại. Nếu lỗi lặp lại, gửi nội dung sau cho
          quản trị viên: <code className="break-all text-foreground">{message || 'không có mô tả'}</code>
        </>
      }
      actions={
        <>
          <Button variant="outline" onClick={onRetry}>
            <RotateCw />
            Thử lại
          </Button>
          <Button onClick={() => window.location.assign(`${window.location.pathname.startsWith('/app') ? '/app' : '/admin'}/`)}>
            <Home />
            Về trang chủ
          </Button>
        </>
      }
    />
  );
}
