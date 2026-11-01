// PocketDesk service worker: notifications (with Allow / Deny buttons) and the phone's Share menu.
// No page caching, so the app is always the laptop's current version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'PocketDesk', body: event.data ? event.data.text() : '' };
  }
  const opts = {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/', decide: data.decide || null },
  };
  if (Array.isArray(data.actions) && data.decide) {
    opts.actions = data.actions.slice(0, 2);
    opts.requireInteraction = true; // Claude is waiting: keep it on screen until answered
  }
  event.waitUntil(self.registration.showNotification(data.title || 'PocketDesk', opts));
});

const open = (url) => (async () => {
  const href = new URL(url || '/', self.location.origin).href;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (new URL(c.url).origin === self.location.origin) {
      await c.focus();
      c.postMessage({ type: 'navigate', url: href });
      return;
    }
  }
  await self.clients.openWindow(href);
})();

/** Allow / Deny straight from the notification. Falls back to opening the app when that cannot work. */
async function answer(d, action, url) {
  const say = (title, body, tag = 'pd-answer') => self.registration.showNotification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url } });
  let r;
  try {
    r = await fetch('/api/push/decide', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-pocketdesk': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sid: d.sid, pid: d.pid, token: d.token, decision: action === 'allow' ? 'allow' : 'deny' }),
    });
  } catch {
    return say('Could not reach the laptop', 'Your answer was not sent. Tap to open PocketDesk and try again.');
  }
  if (r.ok) return say(action === 'allow' ? 'Allowed' : 'Denied', 'Claude got your answer.');
  let msg = '';
  try {
    msg = (await r.json()).error || '';
  } catch {
    /* not json */
  }
  if (r.status === 423) return say('PocketDesk is locked', 'Tap to open it, type your PIN, then answer there. (Or allow notification buttons while locked: Laptop → Security.)');
  if (r.status === 409) return say('Already answered', msg || 'That request was answered or cancelled already.');
  return say('Answer not sent', msg || `The laptop said ${r.status}. Tap to open PocketDesk.`);
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  if (event.action && d.decide) event.waitUntil(answer(d.decide, event.action, d.url));
  else event.waitUntil(open(d.url));
});

// ---- Share to PocketDesk (Android share menu): keep what was shared, then open the Send screen ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const cache = await caches.open('pd-share');
      for (const k of await cache.keys()) await cache.delete(k);
      const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'size' in f);
      const meta = { at: Date.now(), title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''), files: [] };
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        meta.files.push({ i, name: f.name || `shared-${i + 1}`, type: f.type || 'application/octet-stream', size: f.size });
        await cache.put(`/shared/file/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
      }
      await cache.put('/shared/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
    } catch {
      /* the Send screen says nothing arrived */
    }
    return Response.redirect('/#/send?shared=1', 303);
  })());
});
