import { useEffect } from 'react';

const APP_NAME = 'bv-agent-msg';

/** Sets the browser tab title to "<title> · bv-agent-msg" while the calling page is mounted. */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
