import { createContext, FormEvent, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PasswordInput } from '@/components/password-input';
import { Label } from '@/components/ui/label';

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

interface PasswordOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
}

interface Dialogs {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  askPassword: (options: PasswordOptions) => Promise<string | null>;
}

const DialogsContext = createContext<Dialogs | null>(null);

/** Promise-based replacements for window.confirm / window.prompt that match the app's design. */
export function useDialogs() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useDialogs must be used inside <DialogsProvider>');
  return ctx;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);
  const [passwordState, setPasswordState] = useState<PasswordOptions | null>(null);
  const [password, setPassword] = useState('');
  const resolveConfirm = useRef<(v: boolean) => void>(() => {});
  const resolvePassword = useRef<(v: string | null) => void>(() => {});

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolveConfirm.current = resolve;
        setConfirmState(options);
      }),
    [],
  );

  const askPassword = useCallback(
    (options: PasswordOptions) =>
      new Promise<string | null>((resolve) => {
        resolvePassword.current = resolve;
        setPassword('');
        setPasswordState(options);
      }),
    [],
  );

  const closeConfirm = (value: boolean) => {
    resolveConfirm.current(value);
    setConfirmState(null);
  };

  const closePassword = (value: string | null) => {
    resolvePassword.current(value);
    setPasswordState(null);
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    closePassword(password);
  };

  return (
    <DialogsContext.Provider value={{ confirm, askPassword }}>
      {children}

      <AlertDialog open={!!confirmState} onOpenChange={(open) => !open && closeConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            {confirmState?.description && <AlertDialogDescription>{confirmState.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => closeConfirm(false)}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmState?.destructive ? 'destructive' : 'default'}
              onClick={() => closeConfirm(true)}
            >
              {confirmState?.confirmLabel ?? 'Đồng ý'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!passwordState} onOpenChange={(open) => !open && closePassword(null)}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitPassword} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{passwordState?.title}</DialogTitle>
              {passwordState?.description && <DialogDescription>{passwordState.description}</DialogDescription>}
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="dialog-password">Mật khẩu mới</Label>
              <PasswordInput
                id="dialog-password"
                autoComplete="new-password"
                autoFocus
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Tối thiểu 6 ký tự.</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => closePassword(null)}>
                Huỷ
              </Button>
              <Button type="submit">{passwordState?.confirmLabel ?? 'Đổi mật khẩu'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DialogsContext.Provider>
  );
}
