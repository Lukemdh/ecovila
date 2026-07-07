(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const LOGIN_PATH = 'index.html';
  const DASHBOARD_PATH = 'dashboard.html';
  const STAFF_USERNAME_DOMAIN = 'crm.ecovila.local';
  const AUTH_COOKIE_PREFIX = 'ecovila_crm_auth_';
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

  function storageName(key) {
    return `${AUTH_COOKIE_PREFIX}${String(key || 'session')}`;
  }

  // localStorage-backed session storage (ADR-091). The previous cookie storage
  // was scoped Path=/admin, so 90-day-refreshable staff tokens rode the Cookie
  // header to the static web host on EVERY /admin request and sat in its access
  // logs; localStorage never leaves the browser. A legacy cookie session is
  // migrated on first read (so nobody is logged out by the switch), then the
  // cookie is deleted.
  function createLocalAuthStorage(documentRef, storageRef) {
    return {
      getItem(key) {
        let value = null;
        try {
          value = storageRef?.getItem(storageName(key)) ?? null;
        } catch (error) {
          value = null;
        }
        if (value !== null) {
          return value;
        }

        const legacy = readCookie(documentRef, cookieName(key));
        if (legacy !== null) {
          try {
            storageRef?.setItem(storageName(key), legacy);
          } catch (error) {
            // Storage may be unavailable (private mode); the cookie value still
            // authenticates this page view.
          }
          removeCookie(documentRef, cookieName(key));
        }
        return legacy;
      },
      setItem(key, value) {
        try {
          storageRef?.setItem(storageName(key), String(value || ''));
        } catch (error) {
          // ignore — a failed persist only shortens the session to this tab
        }
      },
      removeItem(key) {
        try {
          storageRef?.removeItem(storageName(key));
        } catch (error) {
          // ignore
        }
        removeCookie(documentRef, cookieName(key));
      },
    };
  }

  function clearCrmAuthStorage(documentRef, storageRef) {
    clearCrmAuthCookies(documentRef);
    try {
      const doomed = [];
      for (let index = 0; index < (storageRef?.length || 0); index += 1) {
        const name = storageRef.key(index);
        if (name && name.startsWith(AUTH_COOKIE_PREFIX)) {
          doomed.push(name);
        }
      }
      doomed.forEach((name) => storageRef.removeItem(name));
    } catch (error) {
      // ignore
    }
  }

  async function getClient() {
    return getHelpers().getSupabaseClient({
      root,
      authStorage: createLocalAuthStorage(root.document, root.localStorage),
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
      clearCrmAuthStorage(root.document, root.localStorage);
      root.location.href = LOGIN_PATH;
      return null;
    }

    const role = getRole(session);
    if (!['diana', 'angela'].includes(role)) {
      await client.auth.signOut();
      clearCrmAuthStorage(root.document, root.localStorage);
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
    clearCrmAuthStorage(root.document, root.localStorage);
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
    createLocalAuthStorage,
    requireSession,
    signOut,
  };
});
