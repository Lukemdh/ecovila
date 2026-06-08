(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const LOGIN_PATH = 'index.html';
  const DASHBOARD_PATH = 'dashboard.html';
  const STAFF_USERNAME_DOMAIN = 'crm.ecovila.local';
  const AUTH_COOKIE_PREFIX = 'ecovila_crm_auth_';
  const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;
  const AUTH_COOKIE_PATH = '/admin';

  function getHelpers() {
    return root.EcoVilaSupabase;
  }

  function showMessage(element, message) {
    if (!element) {
      return;
    }

    element.textContent = message || '';
    element.hidden = !message;
  }

  function cookieName(key) {
    return `${AUTH_COOKIE_PREFIX}${encodeURIComponent(String(key || 'session'))}`;
  }

  function readCookie(documentRef, name) {
    const prefix = `${name}=`;
    const cookie = String(documentRef?.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix));

    if (!cookie) {
      return null;
    }

    try {
      return decodeURIComponent(cookie.slice(prefix.length));
    } catch (error) {
      return null;
    }
  }

  function writeCookie(documentRef, name, value) {
    if (!documentRef) {
      return;
    }

    documentRef.cookie = `${name}=${encodeURIComponent(value)}; Path=${AUTH_COOKIE_PATH}; Max-Age=${AUTH_COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  function removeCookie(documentRef, name) {
    if (!documentRef) {
      return;
    }

    documentRef.cookie = `${name}=; Path=${AUTH_COOKIE_PATH}; Max-Age=0; SameSite=Lax`;
  }

  function clearCrmAuthCookies(documentRef) {
    String(documentRef?.cookie || '')
      .split(';')
      .map((value) => value.trim().split('=')[0])
      .filter((name) => name.startsWith(AUTH_COOKIE_PREFIX))
      .forEach((name) => removeCookie(documentRef, name));
  }

  function createCookieAuthStorage(documentRef) {
    return {
      getItem(key) {
        return readCookie(documentRef, cookieName(key));
      },
      setItem(key, value) {
        writeCookie(documentRef, cookieName(key), String(value || ''));
      },
      removeItem(key) {
        removeCookie(documentRef, cookieName(key));
      },
    };
  }

  async function getClient() {
    return getHelpers().getSupabaseClient({
      root,
      authStorage: createCookieAuthStorage(root.document),
    });
  }

  async function getSession(client) {
    const result = await client.auth.getSession();

    if (result.error) {
      throw result.error;
    }

    return result.data?.session || null;
  }

  function getRole(session) {
    return session?.user?.app_metadata?.role || '';
  }

  function normalizeCrmLoginIdentifier(value) {
    const identifier = String(value || '').trim().toLowerCase();

    if (!identifier || identifier.includes('@')) {
      return identifier;
    }

    return `${identifier}@${STAFF_USERNAME_DOMAIN}`;
  }

  async function requireSession(options) {
    const client = options?.client || await getClient();
    const session = await getSession(client);

    if (!session) {
      clearCrmAuthCookies(root.document);
      root.location.href = LOGIN_PATH;
      return null;
    }

    const role = getRole(session);
    if (!['diana', 'angela'].includes(role)) {
      await client.auth.signOut();
      clearCrmAuthCookies(root.document);
      root.location.href = LOGIN_PATH;
      return null;
    }

    return { client, session, role };
  }

  function initLogin() {
    const documentRef = root.document;
    const form = documentRef?.querySelector('[data-crm-login-form]');

    if (!form) {
      return;
    }

    const message = documentRef.querySelector('[data-crm-login-message]');
    const submit = documentRef.querySelector('[data-crm-login-submit]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showMessage(message, '');

      try {
        const client = await getClient();
        const loginIdentifier = form.querySelector('[data-crm-email]')?.value?.trim();
        const password = form.querySelector('[data-crm-password]')?.value || '';

        if (!loginIdentifier || !password) {
          showMessage(message, 'Completează utilizatorul și parola.');
          return;
        }

        if (submit) {
          submit.disabled = true;
        }

        const result = await client.auth.signInWithPassword({
          email: normalizeCrmLoginIdentifier(loginIdentifier),
          password,
        });

        if (result.error) {
          throw result.error;
        }

        root.location.href = DASHBOARD_PATH;
      } catch (error) {
        showMessage(message, error?.message || 'Autentificarea nu a reușit.');
      } finally {
        if (submit) {
          submit.disabled = false;
        }
      }
    });
  }

  async function signOut(client) {
    await client.auth.signOut();
    clearCrmAuthCookies(root.document);
    root.location.href = LOGIN_PATH;
  }

  if (root.document?.querySelector('[data-crm-login-page]')) {
    initLogin();
  }

  return {
    getRole,
    getSession,
    initLogin,
    normalizeCrmLoginIdentifier,
    createCookieAuthStorage,
    requireSession,
    signOut,
  };
});
