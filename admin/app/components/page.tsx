import { cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useDocumentTitle } from '@/hooks/use-document-title';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl space-y-6 p-6 lg:p-8', className)}>{children}</div>;
}

export function PageHeader(props: {
  title: ReactNode;
  /** Browser tab title; defaults to `title` when it is plain text. */
  docTitle?: string;
  description?: ReactNode;
  back?: ReactNode;
  actions?: ReactNode;
}) {
  useDocumentTitle(props.docTitle ?? (typeof props.title === 'string' ? props.title : null));
  return (
    <div className="space-y-1">
      {props.back && <div className="text-sm">{props.back}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
          {props.description && <p className="max-w-3xl text-sm text-muted-foreground">{props.description}</p>}
        </div>
        {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
      </div>
    </div>
  );
}

export function Notices({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert className="border-success/30 bg-success/5 text-foreground">
          <CheckCircle2 className="text-success" />
          <AlertDescription className="text-foreground">{notice}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

interface ControlAria {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

/** Id of the hint/error text under a `Field`, for controls that set `aria-describedby` by hand. */
export const fieldMessageId = (controlId: string) => `${controlId}-msg`;

export function Field(props: {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the field in place of the hint. */
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const msgId = fieldMessageId(props.htmlFor ?? autoId);
  const hasMessage = Boolean(props.error || props.hint);

  // Link the hint/error to a single control so screen readers announce it on focus, not only when it appears.
  // Multi-child fields (control + extra content) wire `fieldMessageId(htmlFor)` themselves.
  let control = props.children;
  if (isValidElement<ControlAria>(control)) {
    const own = control.props;
    control = cloneElement(control, {
      'aria-describedby': [own['aria-describedby'], hasMessage ? msgId : undefined].filter(Boolean).join(' ') || undefined,
      'aria-invalid': props.error ? true : own['aria-invalid'],
    });
  }

  return (
    <div className={cn('grid content-start gap-2', props.className)}>
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {control}
      {props.error ? (
        <p id={msgId} className="text-xs text-destructive" role="alert">
          {props.error}
        </p>
      ) : (
        props.hint && (
          <p id={msgId} className="text-xs text-muted-foreground">
            {props.hint}
          </p>
        )
      )}
    </div>
  );
}

export function Loading({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export { LoadErrorPage as LoadError } from './error-pages';

export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', className)}>{children}</div>;
}

export function Section(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
          {props.description && <p className="text-sm text-muted-foreground">{props.description}</p>}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}
