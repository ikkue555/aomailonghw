import {
  ExamSchedule,
  Homework,
  NotificationPreferences,
  PushDispatchLogEntry,
  RegisteredPushDevice,
  ReminderRule,
  TodoItem,
} from '../types';
import { detectDeviceEnvironment } from './usePWAInstall';

// In-memory Bearer token cache (never stored in localStorage/sessionStorage)
let cachedToken: string | null = null;
let cachedUid: string | null = null;
let cachedExpiresAt = 0;

// Cached probe of whether an optional VAPID backend is configured & reachable
let cachedVapidProbe: { checkedAt: number; available: boolean; publicKey: string | null } | null = null;
const VAPID_PROBE_TTL_MS = 5 * 60_000;

export function clearPushSessionToken(): void {
  cachedToken = null;
  cachedUid = null;
  cachedExpiresAt = 0;
}

function getLocalLogsKey(uid: string): string {
  return `hw_local_push_logs_${uid}`;
}

function getLocalSentKeysStorageKey(uid: string): string {
  return `hw_local_sent_keys_${uid}`;
}

function loadLocalDispatchLogs(uid: string): PushDispatchLogEntry[] {
  try {
    const raw = localStorage.getItem(getLocalLogsKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLocalDispatchLog(uid: string, entry: PushDispatchLogEntry): void {
  try {
    const existing = loadLocalDispatchLogs(uid);
    const updated = [entry, ...existing].slice(0, 20);
    localStorage.setItem(getLocalLogsKey(uid), JSON.stringify(updated));
  } catch {
    // ignore storage quota errors
  }
}

function loadLocalSentKeys(uid: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(getLocalSentKeysStorageKey(uid));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalSentKeys(uid: string, keys: Record<string, number>): void {
  try {
    localStorage.setItem(getLocalSentKeysStorageKey(uid), JSON.stringify(keys));
  } catch {
    // ignore
  }
}

async function getPushSessionToken(uid: string): Promise<string> {
  if (cachedToken && cachedUid === uid && Date.now() < cachedExpiresAt - 60_000) {
    return cachedToken;
  }

  const res = await fetch('/api/push/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'ไม่สามารถยืนยันสิทธิ์ระบบแจ้งเตือนได้');
  }

  const data = await res.json();
  cachedToken = data.token;
  cachedUid = uid;
  cachedExpiresAt = data.expiresAt || Date.now() + 3600_000;
  return cachedToken!;
}

async function authedPushFetch(
  uid: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  let token = await getPushSessionToken(uid);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    clearPushSessionToken();
    token = await getPushSessionToken(uid);
    headers.set('Authorization', `Bearer ${token}`);
    res = await fetch(url, { ...init, headers });
  }
  return res;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getDeviceInfo(): { deviceType: 'ios' | 'android' | 'desktop'; deviceLabel: string } {
  const env = detectDeviceEnvironment();
  if (env.isIOS) {
    return {
      deviceType: 'ios',
      deviceLabel: env.isStandalone ? 'iPhone / iPad (PWA)' : 'iOS Safari',
    };
  }
  if (env.isAndroid) {
    return {
      deviceType: 'android',
      deviceLabel: env.isStandalone ? 'Android (App)' : 'Android Browser',
    };
  }
  return {
    deviceType: 'desktop',
    deviceLabel: 'คอมพิวเตอร์ / เว็บเบราว์เซอร์',
  };
}

async function getReadyServiceWorkerOptional(timeoutMs = 3500): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!('serviceWorker' in navigator)) return null;

    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      const base = import.meta.env.BASE_URL || '/';
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      const swPath = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : `${normalizedBase}sw.js`;
      try {
        reg = await navigator.serviceWorker.register(swPath, { scope: normalizedBase });
      } catch {
        reg = await navigator.serviceWorker
          .register(`${normalizedBase}push-sw.js`, { scope: normalizedBase })
          .catch(() => undefined);
      }
    }

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );
    const readyReg = await Promise.race([navigator.serviceWorker.ready, timeoutPromise]);
    return readyReg || reg || null;
  } catch {
    return null;
  }
}

export async function probeOptionalVapid(): Promise<{ available: boolean; publicKey: string | null }> {
  if (cachedVapidProbe && Date.now() - cachedVapidProbe.checkedAt < VAPID_PROBE_TTL_MS) {
    return { available: cachedVapidProbe.available, publicKey: cachedVapidProbe.publicKey };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('/api/push/vapid-public-key', { signal: controller.signal });
    clearTimeout(timer);

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      cachedVapidProbe = { checkedAt: Date.now(), available: false, publicKey: null };
      return { available: false, publicKey: null };
    }

    const data = await res.json();
    const publicKey =
      data?.available !== false && typeof data?.publicKey === 'string' && data.publicKey.trim()
        ? data.publicKey.trim()
        : null;
    const available = Boolean(publicKey);
    cachedVapidProbe = { checkedAt: Date.now(), available, publicKey };
    return { available, publicKey };
  } catch {
    cachedVapidProbe = { checkedAt: Date.now(), available: false, publicKey: null };
    return { available: false, publicKey: null };
  }
}

export async function getVapidPublicKey(): Promise<string | null> {
  const probe = await probeOptionalVapid();
  return probe.publicKey;
}

export async function getCurrentBrowserSubscription(): Promise<PushSubscription | null> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export function isRunningInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function showClientNotification(options: {
  uid?: string;
  title: string;
  body: string;
  tag?: string;
  tab?: string;
  homeworkId?: string;
  delaySeconds?: number;
  recordLog?: boolean;
}): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  const delaySeconds = Math.max(0, Math.min(30, Math.floor(options.delaySeconds || 0)));
  const iconUrl = `${import.meta.env.BASE_URL || '/'}pwa-192x192.png`.replace(/\/{2,}/g, '/');
  const reg = await getReadyServiceWorkerOptional(2000);

  const fireImmediate = async () => {
    let shownViaSw = false;
    if (reg && typeof reg.showNotification === 'function') {
      try {
        await reg.showNotification(options.title, {
          body: options.body,
          icon: iconUrl,
          badge: iconUrl,
          tag: options.tag || `hw-notif-${Date.now()}`,
          data: {
            url: options.homeworkId
              ? `?tab=${encodeURIComponent(options.tab || 'main')}&hw=${encodeURIComponent(options.homeworkId)}`
              : `?tab=${encodeURIComponent(options.tab || 'main')}`,
            tab: options.tab || 'main',
            homeworkId: options.homeworkId || null,
          },
        });
        shownViaSw = true;
      } catch {
        shownViaSw = false;
      }
    }

    if (!shownViaSw) {
      try {
        const notif = new Notification(options.title, {
          body: options.body,
          icon: iconUrl,
          tag: options.tag || `hw-notif-${Date.now()}`,
        });
        notif.onclick = () => {
          window.focus();
          notif.close();
        };
      } catch {
        // Ignore if environment suppresses Notification constructor
      }
    }

    if (options.uid && options.recordLog !== false) {
      appendLocalDispatchLog(options.uid, {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: options.title,
        body: options.body,
        sentAt: new Date().toISOString(),
        successCount: 1,
        failCount: 0,
      });
    }
  };

  if (delaySeconds > 0) {
    if (reg?.active) {
      reg.active.postMessage({
        type: 'SHOW_NOTIFICATION',
        title: options.title,
        body: options.body,
        icon: iconUrl,
        badge: iconUrl,
        tag: options.tag || `test-local-${Date.now()}`,
        tab: options.tab || 'main',
        homeworkId: options.homeworkId,
        delaySeconds,
      });
      if (options.uid && options.recordLog !== false) {
        setTimeout(() => {
          appendLocalDispatchLog(options.uid!, {
            id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            title: options.title,
            body: options.body,
            sentAt: new Date().toISOString(),
            successCount: 1,
            failCount: 0,
          });
        }, delaySeconds * 1000);
      }
      return;
    }

    setTimeout(() => {
      void fireImmediate();
    }, delaySeconds * 1000);
    return;
  }

  await fireImmediate();
}

export async function subscribeDeviceToWebPush(
  uid: string,
  preferences: NotificationPreferences
): Promise<{
  subscription: PushSubscription | null;
  subscribedCount: number;
  mode: 'webpush' | 'local';
}> {
  const env = detectDeviceEnvironment();

  if (!('Notification' in window)) {
    if (env.needsIOSInstall) {
      throw new Error(
        'บน iPhone/iPad กรุณากดปุ่ม "แชร์" ใน Safari แล้วเลือก "เพิ่มไปยังหน้าจอโฮม" ก่อน จากนั้นเปิดแอปจากหน้าจอโฮมเพื่อกดอนุญาตแจ้งเตือน'
      );
    }
    throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน (Notification API)');
  }

  // Must invoke requestPermission() immediately within the user click gesture
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    if (permission === 'denied' && isRunningInIframe()) {
      throw new Error(
        'เบราว์เซอร์บล็อกการขอสิทธิ์แจ้งเตือนในหน้าต่างแสดงตัวอย่าง (iframe) กรุณากดปุ่ม "เปิดในแท็บใหม่" ด้านล่างเพื่ออนุญาตแจ้งเตือนได้ทันที'
      );
    }
    throw new Error(
      permission === 'denied'
        ? 'คุณได้ปฏิเสธสิทธิ์การแจ้งเตือนไว้ กรุณาแตะไอคอนตั้งค่า/รูปกุญแจข้างแถบที่อยู่เว็บ แล้วเปลี่ยน Notifications เป็น "อนุญาต (Allow)" จากนั้นกดเปิดอีกครั้ง'
        : 'กรุณากด "อนุญาต (Allow)" ในหน้าต่างของเบราว์เซอร์เพื่อเปิดรับการแจ้งเตือน'
    );
  }

  const reg = await getReadyServiceWorkerOptional(3500);

  // Optional VAPID Web Push upgrade/fallback (never required or fatal if absent)
  let subscription: PushSubscription | null = null;
  let subscribedCount = 1;
  let mode: 'webpush' | 'local' = 'local';

  try {
    const { available, publicKey } = await probeOptionalVapid();
    if (available && publicKey && reg && 'PushManager' in window) {
      const appServerKey = urlBase64ToUint8Array(publicKey);
      subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        const existingKey = subscription.options?.applicationServerKey;
        if (existingKey) {
          const existingBytes = new Uint8Array(existingKey);
          if (!arraysEqual(existingBytes, appServerKey)) {
            await subscription.unsubscribe().catch(() => {});
            subscription = null;
          }
        }
      }

      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        });
      }

      const { deviceType, deviceLabel } = getDeviceInfo();
      const res = await authedPushFetch(uid, '/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          deviceType,
          deviceLabel,
          preferences: {
            ...preferences,
            enabled: true,
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        subscribedCount = data.subscribedCount || 1;
        mode = 'webpush';
      }
    }
  } catch (err) {
    console.warn('[Notifications] Optional VAPID Web Push skipped; using browser/SW notifications:', err);
  }

  await showClientNotification({
    uid,
    title: '🔔 เปิดการแจ้งเตือนสำเร็จ!',
    body:
      mode === 'webpush'
        ? 'ระบบจะแจ้งเตือนงานล่วงหน้าให้คุณอัตโนมัติ (Web Push + เบราว์เซอร์)'
        : 'ระบบจะแจ้งเตือนงานล่วงหน้าตามเวลาที่กำหนดให้คุณโดยอัตโนมัติ',
    tag: 'push-enabled-welcome',
    tab: 'main',
    recordLog: false,
  });

  return {
    subscription,
    subscribedCount,
    mode,
  };
}

export async function ensureActiveSubscriptionSynced(
  uid: string,
  preferences: NotificationPreferences
): Promise<boolean> {
  try {
    if (!preferences.enabled) return false;
    const env = detectDeviceEnvironment();
    if (!env.supportsWebPush || Notification.permission !== 'granted') return false;

    const { available, publicKey } = await probeOptionalVapid();
    if (!available || !publicKey) return false;

    const reg = await getReadyServiceWorkerOptional(3000);
    if (!reg) return false;

    const appServerKey = urlBase64ToUint8Array(publicKey);
    let subscription = await reg.pushManager.getSubscription();
    if (subscription && subscription.options?.applicationServerKey) {
      const existingBytes = new Uint8Array(subscription.options.applicationServerKey);
      if (!arraysEqual(existingBytes, appServerKey)) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
    }

    const { deviceType, deviceLabel } = getDeviceInfo();
    const res = await authedPushFetch(uid, '/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        deviceType,
        deviceLabel,
        preferences: {
          ...preferences,
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unsubscribeDeviceFromWebPush(uid: string): Promise<void> {
  const existing = await getCurrentBrowserSubscription();
  const endpoint = existing?.endpoint;
  if (existing) {
    await existing.unsubscribe().catch(() => {});
  }

  try {
    const { available } = await probeOptionalVapid();
    if (!available) return;
    await authedPushFetch(uid, '/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: endpoint || '', all: !endpoint }),
    });
  } catch {
    // Non-fatal when optional push backend is unavailable
  }
}

export async function savePushPreferencesToServer(
  uid: string,
  preferences: NotificationPreferences
): Promise<void> {
  try {
    const { available } = await probeOptionalVapid();
    if (!available) return;
    await authedPushFetch(uid, '/api/push/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: {
          ...preferences,
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        },
      }),
    });
  } catch {
    // Non-fatal fallback when running statically (e.g. GitHub Pages)
  }
}

export async function syncTasksToPushServer(
  uid: string,
  payload: {
    homeworks: Homework[];
    exams: ExamSchedule[];
    todos: TodoItem[];
    preferences?: NotificationPreferences;
  }
): Promise<void> {
  try {
    const { available } = await probeOptionalVapid();
    if (!available) return;

    const slimHomeworks = payload.homeworks.map((h) => ({
      id: h.id,
      subject: h.subject,
      title: h.title,
      dueDate: h.dueDate,
      dueTime: h.dueTime,
      progress: h.progress,
      completed: h.completed,
      priority: h.priority,
      customReminders: h.customReminders,
      muteNotifications: h.muteNotifications,
    }));

    const slimExams = payload.exams.map((ex) => ({
      id: ex.id,
      subject: ex.subject,
      examType: ex.examType,
      date: ex.date,
      startTime: ex.startTime,
      isCompleted: ex.isCompleted,
    }));

    const slimTodos = payload.todos.map((td) => ({
      id: td.id,
      title: td.title,
      date: td.date,
      time: td.time,
      completed: td.completed,
      type: td.type,
    }));

    await authedPushFetch(uid, '/api/push/sync-tasks', {
      method: 'POST',
      body: JSON.stringify({
        homeworks: slimHomeworks,
        exams: slimExams,
        todos: slimTodos,
        preferences: payload.preferences
          ? {
              ...payload.preferences,
              timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            }
          : undefined,
      }),
    });
  } catch {
    // Non-fatal fallback when running without backend
  }
}

export async function fetchPushStatus(uid: string): Promise<{
  subscribedCount: number;
  devices: RegisteredPushDevice[];
  recentLogs: PushDispatchLogEntry[];
  vapidAvailable: boolean;
}> {
  const localLogs = loadLocalDispatchLogs(uid);
  const { deviceType, deviceLabel } = getDeviceInfo();
  const hasPermission = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const localDevice: RegisteredPushDevice[] = hasPermission
    ? [
        {
          endpointHash: 'local-browser',
          deviceType,
          deviceLabel: `${deviceLabel} (อุปกรณ์นี้)`,
          createdAt: new Date().toISOString(),
          lastSuccessAt: localLogs[0]?.sentAt,
        },
      ]
    : [];

  try {
    const { available } = await probeOptionalVapid();
    if (!available) {
      return {
        subscribedCount: localDevice.length,
        devices: localDevice,
        recentLogs: localLogs,
        vapidAvailable: false,
      };
    }

    const res = await authedPushFetch(uid, '/api/push/status');
    if (!res.ok) {
      return {
        subscribedCount: localDevice.length,
        devices: localDevice,
        recentLogs: localLogs,
        vapidAvailable: false,
      };
    }

    const data = await res.json();
    const serverDevices: RegisteredPushDevice[] = Array.isArray(data.devices) ? data.devices : [];
    const serverLogs: PushDispatchLogEntry[] = Array.isArray(data.recentLogs) ? data.recentLogs : [];
    const mergedDevices = serverDevices.length > 0 ? serverDevices : localDevice;
    const mergedLogs = [...localLogs, ...serverLogs]
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
      .slice(0, 20);

    return {
      subscribedCount: mergedDevices.length,
      devices: mergedDevices,
      recentLogs: mergedLogs,
      vapidAvailable: Boolean(data.vapidAvailable),
    };
  } catch {
    return {
      subscribedCount: localDevice.length,
      devices: localDevice,
      recentLogs: localLogs,
      vapidAvailable: false,
    };
  }
}

export async function sendTestPushNotification(
  uid: string,
  delaySeconds = 0
): Promise<{ ok: boolean; mode: 'webpush' | 'local'; successCount?: number; scheduledInSeconds?: number }> {
  if (typeof Notification === 'undefined') {
    throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
  }

  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      throw new Error('กรุณากดอนุญาตการแจ้งเตือนในเบราว์เซอร์ก่อนทดสอบ');
    }
  }

  // Try optional VAPID server Web Push first only if backend & subscription exist
  try {
    const { available } = await probeOptionalVapid();
    const sub = await getCurrentBrowserSubscription();
    if (available && sub) {
      const res = await authedPushFetch(uid, '/api/push/test', {
        method: 'POST',
        body: JSON.stringify({ delaySeconds }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.mode !== 'local' && (data.successCount || 0) > 0) {
          return { ok: true, mode: 'webpush', ...data };
        }
        if (data.mode !== 'local' && delaySeconds > 0 && data.scheduledInSeconds) {
          return { ok: true, mode: 'webpush', ...data };
        }
      }
    }
  } catch {
    // Fallback gracefully to direct Service Worker / Browser notification below
  }

  await showClientNotification({
    uid,
    title: '🔔 ทดสอบแจ้งเตือนการบ้าน',
    body: 'ระบบแจ้งเตือนทำงานปกติ! การแจ้งเตือนงานใกล้ครบกำหนดส่งพร้อมใช้งานแล้ว',
    tag: `test-notif-${Date.now()}`,
    tab: 'main',
    delaySeconds,
    recordLog: true,
  });

  return {
    ok: true,
    mode: 'local',
    successCount: 1,
    scheduledInSeconds: delaySeconds > 0 ? delaySeconds : undefined,
  };
}

function formatRemainingThaiClient(diffMs: number): string {
  if (diffMs <= 60_000) return 'ถึงกำหนดส่งแล้ว!';
  const totalMinutes = Math.round(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} วัน`);
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (days === 0 && mins > 0) parts.push(`${mins} นาที`);
  return `อีก ${parts.join(' ')} ส่ง`;
}

function parseLocalDateTimeEpoch(dateStr: string, timeStr?: string, fallback = '20:00'): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const resolvedTime = timeStr && /^\d{2}:\d{2}$/.test(timeStr) ? timeStr : fallback;
  const [hh, mm] = resolvedTime.split(':').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

export async function processLocalDueReminders(
  uid: string,
  homeworks: Homework[],
  exams: ExamSchedule[],
  todos: TodoItem[],
  prefs: NotificationPreferences
): Promise<Array<{ id: string; title: string; body: string; tab: 'main' | 'exam' | 'todo'; homeworkId?: string }>> {
  if (!prefs.enabled) return [];
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return [];

  const nowMs = Date.now();
  const defaultTime = prefs.defaultDueTime || '20:00';
  const activeGlobalRules = prefs.rules.filter((r) => r.enabled);
  const sentKeys = loadLocalSentKeys(uid);

  // Prune keys older than 14 days
  let keysDirty = false;
  for (const [k, ts] of Object.entries(sentKeys)) {
    if (nowMs - ts > 14 * 24 * 60 * 60_000) {
      delete sentKeys[k];
      keysDirty = true;
    }
  }

  const triggered: Array<{
    id: string;
    title: string;
    body: string;
    tab: 'main' | 'exam' | 'todo';
    homeworkId?: string;
  }> = [];

  const jobs: Array<{
    kind: 'hw' | 'exam' | 'todo';
    id: string;
    titlePrefix: string;
    subjectOrName: string;
    detailLine: string;
    dueDate: string;
    dueTime: string;
    dueAtMs: number;
    rules: ReminderRule[];
    tab: 'main' | 'exam' | 'todo';
    homeworkId?: string;
  }> = [];

  if (prefs.notifyHomeworks) {
    for (const hw of homeworks) {
      if (hw.completed || hw.progress >= 100 || hw.muteNotifications) continue;
      if (!hw.dueDate || hw.dueDate === 'ไม่มีกำหนดส่ง') continue;
      const dueTime = hw.dueTime && /^\d{2}:\d{2}$/.test(hw.dueTime) ? hw.dueTime : defaultTime;
      const dueAtMs = parseLocalDateTimeEpoch(hw.dueDate, hw.dueTime, defaultTime);
      if (!dueAtMs) continue;
      const rules =
        hw.customReminders && hw.customReminders.length > 0
          ? hw.customReminders.filter((r) => r.enabled)
          : activeGlobalRules;
      if (rules.length === 0) continue;

      jobs.push({
        kind: 'hw',
        id: hw.id,
        titlePrefix: 'การบ้าน',
        subjectOrName: hw.subject || 'การบ้าน',
        detailLine: hw.title ? `เรื่อง: ${hw.title}` : 'กรุณาตรวจสอบรายละเอียดงาน',
        dueDate: hw.dueDate,
        dueTime,
        dueAtMs,
        rules,
        tab: 'main',
        homeworkId: hw.id,
      });
    }
  }

  if (prefs.notifyExams && activeGlobalRules.length > 0) {
    for (const ex of exams) {
      if (ex.isCompleted || !ex.date) continue;
      const dueTime = ex.startTime && /^\d{2}:\d{2}$/.test(ex.startTime) ? ex.startTime : '08:30';
      const dueAtMs = parseLocalDateTimeEpoch(ex.date, ex.startTime, '08:30');
      if (!dueAtMs) continue;

      jobs.push({
        kind: 'exam',
        id: ex.id,
        titlePrefix: 'สอบ',
        subjectOrName: `${ex.subject} (${ex.examType || 'สอบ'})`,
        detailLine: 'เตรียมความพร้อมทบทวนบทเรียน',
        dueDate: ex.date,
        dueTime,
        dueAtMs,
        rules: activeGlobalRules,
        tab: 'exam',
      });
    }
  }

  if (prefs.notifyTodos && activeGlobalRules.length > 0) {
    for (const td of todos) {
      if (td.completed || !td.date) continue;
      const dueTime = td.time && /^\d{2}:\d{2}$/.test(td.time) ? td.time : defaultTime;
      const dueAtMs = parseLocalDateTimeEpoch(td.date, td.time, defaultTime);
      if (!dueAtMs) continue;

      jobs.push({
        kind: 'todo',
        id: td.id,
        titlePrefix: 'To Do',
        subjectOrName: td.title,
        detailLine: 'รายการสิ่งที่ต้องทำตามแผน',
        dueDate: td.date,
        dueTime,
        dueAtMs,
        rules: activeGlobalRules,
        tab: 'todo',
      });
    }
  }

  for (const job of jobs) {
    for (const rule of job.rules) {
      const leadMs = ((rule.days * 24 + rule.hours) * 60 + (rule.minutes || 0)) * 60_000;
      const triggerAtMs = job.dueAtMs - leadMs;

      if (nowMs >= triggerAtMs && nowMs <= job.dueAtMs + 15 * 60_000) {
        const dedupKey = `${job.kind}:${job.id}:${job.dueAtMs}:${rule.days}d${rule.hours}h${rule.minutes || 0}m`;
        if (sentKeys[dedupKey]) continue;

        sentKeys[dedupKey] = nowMs;
        keysDirty = true;

        const remainingStr = formatRemainingThaiClient(job.dueAtMs - nowMs);
        const iconEmoji = job.kind === 'exam' ? '🎓' : job.kind === 'todo' ? '✅' : '📚';
        const title = `${iconEmoji} ${job.titlePrefix}: ${job.subjectOrName} (${remainingStr})`;
        const body = `${job.detailLine} • กำหนด: ${job.dueDate} ${job.dueTime} น.`;

        await showClientNotification({
          uid,
          title,
          body,
          tag: `${job.kind}-${job.id}-${rule.id}`,
          tab: job.tab,
          homeworkId: job.homeworkId,
          recordLog: true,
        });

        triggered.push({
          id: dedupKey,
          title,
          body,
          tab: job.tab,
          homeworkId: job.homeworkId,
        });
      }
    }
  }

  if (keysDirty) {
    saveLocalSentKeys(uid, sentKeys);
  }

  return triggered;
}

export interface UpcomingPushPreviewItem {
  id: string;
  kind: 'homework' | 'exam' | 'todo';
  title: string;
  dueLabel: string;
  ruleLabel: string;
  notifyAt: Date;
  isDueSoon: boolean;
}

export function formatRuleLabel(rule: Pick<ReminderRule, 'days' | 'hours' | 'minutes'>): string {
  const parts: string[] = [];
  if (rule.days > 0) parts.push(`${rule.days} วัน`);
  if (rule.hours > 0) parts.push(`${rule.hours} ชม.`);
  if ((rule.minutes || 0) > 0) parts.push(`${rule.minutes} นาที`);
  if (parts.length === 0) return 'เมื่อถึงกำหนดส่ง';
  return `ก่อนส่ง ${parts.join(' ')}`;
}

export function computeUpcomingPushPreview(
  homeworks: Homework[],
  exams: ExamSchedule[],
  todos: TodoItem[],
  prefs: NotificationPreferences
): UpcomingPushPreviewItem[] {
  const nowMs = Date.now();
  const defaultTime = prefs.defaultDueTime || '20:00';
  const activeRules = prefs.rules.filter((r) => r.enabled);
  const items: UpcomingPushPreviewItem[] = [];

  const parseLocalDateTime = (dateStr: string, timeStr?: string, fallback = defaultTime): Date | null => {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const resolvedTime = timeStr && /^\d{2}:\d{2}$/.test(timeStr) ? timeStr : fallback;
    const [hh, mm] = resolvedTime.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  };

  if (prefs.notifyHomeworks) {
    for (const hw of homeworks) {
      if (hw.completed || hw.progress >= 100 || hw.muteNotifications) continue;
      if (!hw.dueDate || hw.dueDate === 'ไม่มีกำหนดส่ง') continue;
      const dueDateObj = parseLocalDateTime(hw.dueDate, hw.dueTime, defaultTime);
      if (!dueDateObj) continue;
      const rules =
        hw.customReminders && hw.customReminders.length > 0
          ? hw.customReminders.filter((r) => r.enabled)
          : activeRules;

      for (const rule of rules) {
        const leadMs = ((rule.days * 24 + rule.hours) * 60 + (rule.minutes || 0)) * 60_000;
        const notifyAt = new Date(dueDateObj.getTime() - leadMs);
        if (dueDateObj.getTime() >= nowMs - 15 * 60_000) {
          items.push({
            id: `hw_${hw.id}_${rule.id}`,
            kind: 'homework',
            title: `${hw.subject}${hw.title ? ` — ${hw.title}` : ''}`,
            dueLabel: `${hw.dueDate} ${hw.dueTime && hw.dueTime !== 'ไม่มีเวลากำหนด' ? hw.dueTime : defaultTime} น.`,
            ruleLabel: formatRuleLabel(rule),
            notifyAt,
            isDueSoon: notifyAt.getTime() <= nowMs,
          });
        }
      }
    }
  }

  if (prefs.notifyExams) {
    for (const ex of exams) {
      if (ex.isCompleted || !ex.date) continue;
      const dueDateObj = parseLocalDateTime(ex.date, ex.startTime, '08:30');
      if (!dueDateObj) continue;
      for (const rule of activeRules) {
        const leadMs = ((rule.days * 24 + rule.hours) * 60 + (rule.minutes || 0)) * 60_000;
        const notifyAt = new Date(dueDateObj.getTime() - leadMs);
        if (dueDateObj.getTime() >= nowMs - 15 * 60_000) {
          items.push({
            id: `exam_${ex.id}_${rule.id}`,
            kind: 'exam',
            title: `สอบ: ${ex.subject}`,
            dueLabel: `${ex.date} ${ex.startTime || '08:30'} น.`,
            ruleLabel: formatRuleLabel(rule),
            notifyAt,
            isDueSoon: notifyAt.getTime() <= nowMs,
          });
        }
      }
    }
  }

  if (prefs.notifyTodos) {
    for (const td of todos) {
      if (td.completed || !td.date) continue;
      const dueDateObj = parseLocalDateTime(td.date, td.time, defaultTime);
      if (!dueDateObj) continue;
      for (const rule of activeRules) {
        const leadMs = ((rule.days * 24 + rule.hours) * 60 + (rule.minutes || 0)) * 60_000;
        const notifyAt = new Date(dueDateObj.getTime() - leadMs);
        if (dueDateObj.getTime() >= nowMs - 15 * 60_000) {
          items.push({
            id: `todo_${td.id}_${rule.id}`,
            kind: 'todo',
            title: `To Do: ${td.title}`,
            dueLabel: `${td.date} ${td.time || defaultTime} น.`,
            ruleLabel: formatRuleLabel(rule),
            notifyAt,
            isDueSoon: notifyAt.getTime() <= nowMs,
          });
        }
      }
    }
  }

  items.sort((a, b) => a.notifyAt.getTime() - b.notifyAt.getTime());
  return items.slice(0, 12);
}
