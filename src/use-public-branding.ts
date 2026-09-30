import { useEffect, useState } from 'react';
import { privateFetch } from './client-security';
import { openProjectChannel } from './project-channel';
import { defaultWorkspaceBranding, validWorkspaceBranding, type WorkspaceBranding } from './workspace-types';

export function usePublicBranding(): WorkspaceBranding {
  const [branding, setBranding] = useState<WorkspaceBranding>(defaultWorkspaceBranding);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const response = await privateFetch('/api/branding', { signal: request.signal });
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (!active || request.signal.aborted || !validWorkspaceBranding(value)) return;
        setBranding((current) =>
          current.brandName === value.brandName && current.workspaceName === value.workspaceName
            ? current
            : { brandName: value.brandName, workspaceName: value.workspaceName },
        );
      } catch {
        // Display-name availability must never block login or reset a known name.
      }
    };
    const check = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const timer = window.setInterval(check, 30_000);
    const channel = openProjectChannel('workspace-settings', check);
    window.addEventListener('crm:settings-changed', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      channel?.close();
      window.removeEventListener('crm:settings-changed', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return branding;
}
