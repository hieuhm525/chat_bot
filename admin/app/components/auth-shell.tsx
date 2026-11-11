import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AuthShell(props: { title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_65%)]"
      />
      <main className="relative w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground shadow-sm">
            bv
          </span>
          <span className="text-sm font-semibold">bv-agent-msg</span>
        </div>
        <Card className="shadow-lg shadow-primary/5">
          <CardHeader>
            <CardTitle className="text-xl">{props.title}</CardTitle>
            {props.description && <CardDescription>{props.description}</CardDescription>}
          </CardHeader>
          {props.children && <CardContent>{props.children}</CardContent>}
        </Card>
        {props.footer && <p className="text-center text-xs text-muted-foreground">{props.footer}</p>}
      </main>
    </div>
  );
}
