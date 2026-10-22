// Logs metadata only. Message contents are never written to the log.
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const log = {
  info: (...args: unknown[]) => console.log(ts(), "INFO ", ...args),
  warn: (...args: unknown[]) => console.warn(ts(), "WARN ", ...args),
  error: (...args: unknown[]) => console.error(ts(), "ERROR", ...args),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Shortened Session ID for logs and headers: 05ab12…9f3c */
export function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
