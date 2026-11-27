const repeatOpenWindowMs = 250;

export function createReaderOpenGate(now = Date.now) {
  const recent = new Map<string, { owner: symbol; expiresAt: number }>();

  return {
    claim(key: string, owner: symbol): boolean {
      const time = now();
      for (const [recentKey, entry] of recent) {
        if (entry.expiresAt <= time) recent.delete(recentKey);
      }
      const opening = recent.get(key);
      if (opening) return opening.owner === owner;

      recent.set(key, { owner, expiresAt: time + repeatOpenWindowMs });
      return true;
    },
    release(key: string, owner: symbol) {
      if (recent.get(key)?.owner === owner) recent.delete(key);
    },
  };
}
