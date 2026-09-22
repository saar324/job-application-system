export function needsEmployerApplyUrl(value, boardHost) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === boardHost || hostname.endsWith(`.${boardHost}`);
  } catch { return true; }
}
