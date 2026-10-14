import { roleKeys } from './discovery/handled-roles.js';

// Workday's candidate list omits the location segment and application suffix.
// Match the entire requisition ID, including its suffix, on the same tenant.
export function sameOutcomeRole(expected, observed) {
  const a = new URL(expected), b = new URL(observed);
  if (a.origin !== b.origin) return false;
  if (a.hostname.endsWith('.myworkdayjobs.com')) {
    const identity = url => {
      let parts;
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
      const index = parts.indexOf('job');
      if (index < 0) return null;
      const tail = parts.slice(index + 1);
      while (['apply', 'applyManually'].includes(tail.at(-1))) tail.pop();
      const role = tail.at(-1);
      if (!/_\d+(?:-\d+)?$/.test(role ?? '')) return null;
      const prefix = parts.slice(0, index).filter(part => !/^[a-z]{2}-[a-z]{2}$/i.test(part)).join('/');
      return `${prefix}:${role.match(/_(\d+(?:-\d+)?)$/)[1]}`;
    };
    const id = identity(a);
    return id !== null && id === identity(b);
  }
  const keys = roleKeys({ applyUrl: expected });
  return [...roleKeys({ applyUrl: observed })].some(key => keys.has(key));
}
