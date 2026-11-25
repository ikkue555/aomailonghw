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

export function clearPushSessionToken(): void {
  cachedToken = null;
  cachedUid = null;
  cachedExpiresAt = 0;
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

async function getReadyServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('เบราว์เซอร์นี้ไม่รองรับ Service Worker');
  }

  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) {
    const swPath = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
    try {
      await navigator.serviceWorker.register(swPath, { scope: '/' });
    } catch {
      await navigator.serviceWorker.register('/push-sw.js', { scope: '/' }).catch(() => {});
    }
  }

  // Wait for active registration (timeout after 8s with clear error)
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Service Worker ยังไม่พร้อมใช้งาน กรุณารีเฟรชหน้าเว็บแล้วลองใหม่')), 8000)
  );
  return Promise.race([navigator.serviceWorker.ready, timeoutPromise]);
}

export async function getVapidPublicKey(): Promise<string> {
  const res = await fetch('/api/push/vapid-public-key');
  if (!res.ok) throw new Error('ไม่สามารถโหลด VAPID Key จากเซิร์ฟเวอร์ได้');
  const data = await res.json();
  return data.publicKey;
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

export async function subscribeDeviceToWebPush(
  uid: string,
  preferences: NotificationPreferences
): Promise<{
  subscription: PushSubscription;
  subscribedCount: number;
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
        'เบราว์เซอร์บล็อกการขอสิทธิ์แจ้งเตือนในหน้าต่างแสดงตัวอย่าง (iframe) กรุณากดปุ่ม "เปิดหน้าเว็บในแท็บใหม่" ด้านล่างเพื่ออนุญาตแจ้งเตือนได้ทันที'
      );
    }
    throw new Error(
      permission === 'denied'
        ? 'คุณได้ปฏิเสธสิทธิ์การแจ้งเตือนไว้ กรุณาแตะไอคอนตั้งค่า/รูปกุญแจข้างแถบที่อยู่เว็บ แล้วเปลี่ยน Notifications เป็น "อนุญาต (Allow)" จากนั้นกดเปิดอีกครั้ง'
        : 'กรุณากด "อนุญาต (Allow)" ในหน้าต่างของเบราว์เซอร์เพื่อเปิดรับการแจ้งเตือน'
    );
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (env.needsIOSInstall) {
      throw new Error(
        'บน iPhone/iPad กรุณากดปุ่ม "แชร์" ใน Safari แล้วเลือก "เพิ่มไปยังหน้าจอโฮม" ก่อน จึงจะรับ Web Push ตอนปิดแอปได้'
      );
    }
    throw new Error('เบราว์เซอร์นี้ไม่รองรับ PushManager สำหรับการแจ้งเตือนพื้นหลัง');
  }

  const reg = await getReadyServiceWorker();
  const vapidPublicKey = await getVapidPublicKey();
  const appServerKey = urlBase64ToUint8Array(vapidPublicKey);

  let subscription = await reg.pushManager.getSubscription();
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
  const subJson = subscription.toJSON();
  const res = await authedPushFetch(uid, '/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      subscription: subJson,
      deviceType,
      deviceLabel,
      preferences: {
        ...preferences,
        enabled: true,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'ลงทะเบียนรับแจ้งเตือนกับเซิร์ฟเวอร์ไม่สำเร็จ');
  }

  const data = await res.json();

  // Show an immediate confirmation notification through Service Worker
  try {
    await reg.showNotification('🔔 เปิดการแจ้งเตือนสำเร็จ!', {
      body: 'ระบบจะแจ้งเตือนงานล่วงหน้าให้คุณโดยอัตโนมัติแม้ปิดหน้าเว็บหรือพักหน้าจอ',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: 'push-enabled-welcome',
    });
  } catch {
    // Non-fatal if OS suppresses welcome notification
  }

  return {
    subscription,
    subscribedCount: data.subscribedCount || 1,
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

    const reg = await getReadyServiceWorker();
    const vapidPublicKey = await getVapidPublicKey();
    const appServerKey = urlBase64ToUint8Array(vapidPublicKey);

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
  await authedPushFetch(uid, '/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: endpoint || '', all: !endpoint }),
  });
}

export async function savePushPreferencesToServer(
  uid: string,
  preferences: NotificationPreferences
): Promise<void> {
  const res = await authedPushFetch(uid, '/api/push/preferences', {
    method: 'POST',
    body: JSON.stringify({
      preferences: {
        ...preferences,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      },
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'บันทึกการตั้งค่าแจ้งเตือนไปยังเซิร์ฟเวอร์ไม่สำเร็จ');
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
}

export async function fetchPushStatus(uid: string): Promise<{
  subscribedCount: number;
  devices: RegisteredPushDevice[];
  preferences: NotificationPreferences;
  recentLogs: PushDispatchLogEntry[];
}> {
  const res = await authedPushFetch(uid, '/api/push/status');
  if (!res.ok) {
    throw new Error('ไม่สามารถโหลดสถานะการแจ้งเตือนจากเซิร์ฟเวอร์ได้');
  }
  return res.json();
}

export async function sendTestPushNotification(
  uid: string,
  delaySeconds = 0
): Promise<{ ok: boolean; successCount?: number; scheduledInSeconds?: number }> {
  const res = await authedPushFetch(uid, '/api/push/test', {
    method: 'POST',
    body: JSON.stringify({ delaySeconds }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || 'ส่งการแจ้งเตือนทดสอบไม่สำเร็จ');
  }
  return res.json();
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
