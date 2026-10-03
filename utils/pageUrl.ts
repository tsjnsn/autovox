/** Strip hash + trailing slash so SPA / URL variants match the same page. */
export function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    const bare = (url.split('#')[0] ?? url).replace(/\/$/, '');
    return bare;
  }
}

export function samePageUrl(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizePageUrl(a) === normalizePageUrl(b);
}
