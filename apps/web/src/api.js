function csrfTokenFromCookie(cookieName) {
  const prefix = `${cookieName}=`;
  const found = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : null;
}

async function request(path, options = {}, { csrfCookie } = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (!['GET', 'HEAD'].includes(method) && csrfCookie) {
    const csrf = csrfTokenFromCookie(csrfCookie);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ message: 'Unexpected response.' }));
  if (!response.ok) {
    const detail = Array.isArray(data.details) && data.details[0]?.message;
    const error = new Error(detail || data.message || 'Request failed.');
    Object.assign(error, data, { status: response.status });
    throw error;
  }
  return data;
}

export function api(path, options = {}) {
  return request(path, options, { csrfCookie: 'directqr_csrf' });
}

export function superApi(path, options = {}) {
  return request(`/super-admin${path}`, options, { csrfCookie: 'directqr_super_admin_csrf' });
}
