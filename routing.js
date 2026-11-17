const parameter = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
export function validRoute(name) {
  if (typeof name !== 'string' || !name.length || name.length > 240) return false;
  const names = new Set();
  return name.split('/').every(segment => {
    const match = parameter.exec(segment);
    if (!match) return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(segment);
    if (names.has(match[1])) return false;
    names.add(match[1]);
    return true;
  });
}
export function matchRoute(configs, pathname) {
  let parts;
  try { parts = pathname.split('/').map(decodeURIComponent); }
  catch { throw Object.assign(new Error('Invalid URL encoding.'), { status: 400 }); }
  const candidates = configs.map(config => ({ config, segments: config.name.split('/') }));
  // Prefer literal segments at the first differing position, then a stable name order.
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const difference = Number(parameter.test(a.segments[i])) - Number(parameter.test(b.segments[i]));
      if (difference) return difference;
    }
    return a.config.name.localeCompare(b.config.name);
  });
  for (const { config, segments } of candidates) {
    if (parts.length !== segments.length) continue;
    const params = Object.create(null);
    const matches = segments.every((segment, index) => {
      const match = parameter.exec(segment);
      if (!match) return segment === parts[index];
      if (!parts[index]) return false;
      params[match[1]] = parts[index];
      return true;
    });
    if (matches) return { config, params };
  }
  return null;
}
export function renderResponse(value, params) {
  if (typeof value === 'string') return value.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? params[name] : placeholder);
  if (Array.isArray(value)) return value.map(item => renderResponse(item, params));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderResponse(item, params)]));
  return value;
}
