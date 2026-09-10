export type ProjectChannel = {
  postMessage(message: { type: string }): void;
  close(): void;
};

/** Keep session/policy invalidation working with tabs opened before the rename. */
export function openProjectChannel(
  topic: 'session' | 'workspace-settings',
  onMessage: (event: MessageEvent) => void,
): ProjectChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channels = [new BroadcastChannel(`ieumdesk-${topic}`), new BroadcastChannel(`yeta-crm-${topic}`)];
  const seen = new Set<string>();
  for (const channel of channels) {
    channel.onmessage = (event) => {
      const id = event.data?._ieumdeskEventId;
      if (typeof id === 'string' && id.length <= 128) {
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > 64) seen.delete(seen.values().next().value!);
      }
      onMessage(event);
    };
  }
  return {
    postMessage(message) {
      const shared = { ...message, _ieumdeskEventId: crypto.randomUUID() };
      for (const channel of channels) channel.postMessage(shared);
    },
    close() {
      for (const channel of channels) channel.close();
      seen.clear();
    },
  };
}
