import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Sáng', icon: Sun },
  { value: 'dark', label: 'Tối', icon: Moon },
  { value: 'system', label: 'Theo hệ thống', icon: Monitor },
];

/** Same key as the pre-paint script in admin/index.html; change both together. */
const STORAGE_KEY = 'theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch (err) {
    console.warn('Không đọc được lựa chọn giao diện từ localStorage, dùng "theo hệ thống"', err);
  }
  return 'system';
}

interface ThemeState {
  theme: Theme;
  /** What is actually on screen once "system" is resolved. */
  resolved: 'light' | 'dark';
}

let state: ThemeState = resolve(readStored());
const listeners = new Set<() => void>();

function resolve(theme: Theme): ThemeState {
  return { theme, resolved: theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light' };
}

function apply(next: ThemeState) {
  state = next;
  const root = document.documentElement;
  root.classList.toggle('dark', next.resolved === 'dark');
  root.style.colorScheme = next.resolved;
  listeners.forEach((l) => l());
}

media.addEventListener('change', () => {
  if (state.theme === 'system') apply(resolve('system'));
});

apply(state);

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (err) {
    // Still switch for this tab; it just will not be remembered after a reload.
    console.warn(`Không lưu được lựa chọn giao diện "${theme}" vào localStorage; chỉ áp dụng cho tab này`, err);
  }
  apply(resolve(theme));
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
