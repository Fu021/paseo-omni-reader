const repeatOpenWindowMs = 800;

export function createReaderOpenGate(now = Date.now) {
  const recent = new Map<string, { owner: symbol; expiresAt: number }>();

  return (key: string, owner: symbol): boolean => {
    const time = now();
    for (const [recentKey, entry] of recent) {
      if (entry.expiresAt <= time) recent.delete(recentKey);
    }
    const opening = recent.get(key);
    if (opening) return opening.owner === owner;

    recent.set(key, { owner, expiresAt: time + repeatOpenWindowMs });
    return true;
  };
}
