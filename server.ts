import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Types (erasable TS syntax for native Node 22 + tsx compatibility)
// ---------------------------------------------------------------------------
interface ReminderRule {
  id: string;
  days: number;
  hours: number;
  minutes?: number;
  enabled: boolean;
  label?: string;
}

interface NotificationPreferences {
  enabled: boolean;
  rules: ReminderRule[];
  defaultDueTime: string;
  notifyHomeworks: boolean;
  notifyExams: boolean;
  notifyTodos: boolean;
  timezoneOffsetMinutes: number;
  updatedAt: string;
}

interface StoredSubscription {
  endpoint: string;
  endpointHash: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceType: 'ios' | 'android' | 'desktop';
  deviceLabel: string;
  createdAt: string;
  lastSuccessAt?: string;
}

interface SyncedHomework {
  id: string;
  subject: string;
  title?: string;
  dueDate: string;
  dueTime?: string;
  progress: number;
  completed: boolean;
  priority?: string;
  customReminders?: ReminderRule[];
  muteNotifications?: boolean;
}

interface SyncedExam {
  id: string;
  subject: string;
  examType?: string;
  date: string;
  startTime?: string;
  isCompleted?: boolean;
}

interface SyncedTodo {
  id: string;
  title: string;
  date: string;
  time?: string;
  completed: boolean;
  type?: string;
}

interface DispatchLogEntry {
  id: string;
  title: string;
  body: string;
  sentAt: string;
  successCount: number;
  failCount: number;
}

interface UserPushRecord {
  uid: string;
  subscriptions: StoredSubscription[];
  preferences: NotificationPreferences;
  homeworks: SyncedHomework[];
  exams: SyncedExam[];
  todos: SyncedTodo[];
  sentKeys: Record<string, number>;
  recentLogs: DispatchLogEntry[];
  updatedAt: string;
}

interface PushStoreData {
  users: Record<string, UserPushRecord>;
}

interface AuthedRequest extends Request {
  authUid?: string;
}

// ---------------------------------------------------------------------------
// VAPID & Session Signing Setup (No hardcoded secrets)
// ---------------------------------------------------------------------------
const envVapidPublic = (process.env.VAPID_PUBLIC_KEY || '').trim();
const envVapidPrivate = (process.env.VAPID_PRIVATE_KEY || '').trim();
const vapidSubject = (process.env.VAPID_SUBJECT || 'mailto:admin@homeworkmanager.app').trim();

const hasEnvVapid = Boolean(envVapidPublic && envVapidPrivate);
const generatedKeys = hasEnvVapid ? null : webpush.generateVAPIDKeys();
const VAPID_PUBLIC_KEY = hasEnvVapid ? envVapidPublic : generatedKeys!.publicKey;
const VAPID_PRIVATE_KEY = hasEnvVapid ? envVapidPrivate : generatedKeys!.privateKey;

webpush.setVapidDetails(vapidSubject, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const SESSION_SECRET =
  (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');

// Load public Firebase web config for optional user existence verification
let firebaseWebConfig: {
  projectId?: string;
  apiKey?: string;
  firestoreDatabaseId?: string;
} = {};
try {
  const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    firebaseWebConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch {
  // Ignore if missing
}

// ---------------------------------------------------------------------------
// Persistent Store (.data/push-store.json)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '.data');
const STORE_PATH = path.join(DATA_DIR, 'push-store.json');

function createDefaultPreferences(): NotificationPreferences {
  return {
    enabled: false,
    rules: [
      { id: 'rule_1d', days: 1, hours: 0, minutes: 0, enabled: true, label: 'ล่วงหน้า 1 วัน' },
      { id: 'rule_3h', days: 0, hours: 3, minutes: 0, enabled: true, label: 'ล่วงหน้า 3 ชั่วโมง' },
      { id: 'rule_1h', days: 0, hours: 1, minutes: 0, enabled: false, label: 'ล่วงหน้า 1 ชั่วโมง' },
    ],
    defaultDueTime: '20:00',
    notifyHomeworks: true,
    notifyExams: true,
    notifyTodos: false,
    timezoneOffsetMinutes: -420, // Asia/Bangkok default
    updatedAt: new Date().toISOString(),
  };
}

function loadStore(): PushStoreData {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
        return parsed as PushStoreData;
      }
    }
  } catch (err) {
    console.warn('[PushStore] Failed to load existing store, initializing fresh:', err);
  }
  return { users: {} };
}

const pushStore: PushStoreData = loadStore();
let saveTimer: NodeJS.Timeout | null = null;

function schedulePersistStore(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpPath = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(pushStore, null, 2), 'utf8');
      fs.renameSync(tmpPath, STORE_PATH);
    } catch (err) {
      console.error('[PushStore] Error persisting store:', err);
    }
  }, 400);
}

function getOrCreateUserRecord(uid: string): UserPushRecord {
  if (!pushStore.users[uid]) {
    pushStore.users[uid] = {
      uid,
      subscriptions: [],
      preferences: createDefaultPreferences(),
      homeworks: [],
      exams: [],
      todos: [],
      sentKeys: {},
      recentLogs: [],
      updatedAt: new Date().toISOString(),
    };
  }
  return pushStore.users[uid];
}

// ---------------------------------------------------------------------------
// Security & Validation Helpers
// ---------------------------------------------------------------------------
const ALLOWED_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  '.push.apple.com',
  'web.push.apple.com',
  '.notify.windows.com',
  '.push.samsungosp.com',
  '.push.opera.com',
  'jmt17.google.com',
];

function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  // Reject IPv4/IPv6 literals, localhost, or private hostnames
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':')
  ) {
    return false;
  }
  return ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix || host.endsWith('.' + suffix)
  );
}

function isValidUid(uid: unknown): uid is string {
  return typeof uid === 'string' && /^usr_[a-zA-Z0-9_@.-]{1,180}$/.test(uid);
}

function hashEndpoint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

function signSessionToken(uid: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = Buffer.from(JSON.stringify({ uid, exp: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresAt };
}

function verifySessionToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded || !isValidUid(decoded.uid) || typeof decoded.exp !== 'number') {
      return null;
    }
    if (Date.now() > decoded.exp) {
      return null;
    }
    return decoded.uid;
  } catch {
    return null;
  }
}

function requirePushAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: missing Bearer token' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const uid = verifySessionToken(token);
  if (!uid) {
    res.status(401).json({ error: 'Unauthorized: invalid or expired session token' });
    return;
  }
  req.authUid = uid;
  next();
}

function sanitizeRules(rawRules: unknown): ReminderRule[] {
  if (!Array.isArray(rawRules)) return createDefaultPreferences().rules;
  const cleaned: ReminderRule[] = [];
  for (const item of rawRules.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const days = Math.max(0, Math.min(365, Math.floor(Number(r.days) || 0)));
    const hours = Math.max(0, Math.min(23, Math.floor(Number(r.hours) || 0)));
    const minutes = Math.max(0, Math.min(59, Math.floor(Number(r.minutes) || 0)));
    const id =
      typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64
        ? r.id
        : `rule_${days}d_${hours}h_${minutes}m`;
    const label =
      typeof r.label === 'string' && r.label.trim()
        ? r.label.trim().slice(0, 100)
        : formatLeadLabel(days, hours, minutes);
    cleaned.push({
      id,
      days,
      hours,
      minutes,
      enabled: Boolean(r.enabled),
      label,
    });
  }
  return cleaned;
}

function sanitizePreferences(raw: unknown, existing: NotificationPreferences): NotificationPreferences {
  if (!raw || typeof raw !== 'object') return existing;
  const obj = raw as Record<string, unknown>;
  const defaultDueTime =
    typeof obj.defaultDueTime === 'string' && /^\d{2}:\d{2}$/.test(obj.defaultDueTime)
      ? obj.defaultDueTime
      : existing.defaultDueTime;
  const tzOffset = Number(obj.timezoneOffsetMinutes);
  const timezoneOffsetMinutes =
    Number.isFinite(tzOffset) && tzOffset >= -840 && tzOffset <= 840
      ? Math.round(tzOffset)
      : existing.timezoneOffsetMinutes;

  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : existing.enabled,
    rules: obj.rules !== undefined ? sanitizeRules(obj.rules) : existing.rules,
    defaultDueTime,
    notifyHomeworks:
      typeof obj.notifyHomeworks === 'boolean' ? obj.notifyHomeworks : existing.notifyHomeworks,
    notifyExams: typeof obj.notifyExams === 'boolean' ? obj.notifyExams : existing.notifyExams,
    notifyTodos: typeof obj.notifyTodos === 'boolean' ? obj.notifyTodos : existing.notifyTodos,
    timezoneOffsetMinutes,
    updatedAt: new Date().toISOString(),
  };
}

function formatLeadLabel(days: number, hours: number, minutes = 0): string {
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} วัน`);
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (minutes > 0) parts.push(`${minutes} นาที`);
  if (parts.length === 0) return 'เมื่อถึงเวลากำหนดส่ง';
  return `ล่วงหน้า ${parts.join(' ')}`;
}

function formatRemainingThai(diffMs: number): string {
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

function formatThaiDueDate(dateStr: string, timeStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const months = [
      'ม.ค.',
      'ก.พ.',
      'มี.ค.',
      'เม.ย.',
      'พ.ค.',
      'มิ.ย.',
      'ก.ค.',
      'ส.ค.',
      'ก.ย.',
      'ต.ค.',
      'พ.ย.',
      'ธ.ค.',
    ];
    return `${d} ${months[(m || 1) - 1]} ${(y || 2026) + 543} เวลา ${timeStr} น.`;
  } catch {
    return `${dateStr} ${timeStr}`;
  }
}

function computeDueEpochMs(
  dateStr: string,
  timeStr: string | undefined,
  fallbackTime: string,
  timezoneOffsetMinutes: number
): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const resolvedTime = timeStr && /^\d{2}:\d{2}$/.test(timeStr) ? timeStr : fallbackTime;
  const [hour, minute] = resolvedTime.split(':').map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) + timezoneOffsetMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Push Dispatch Engine & Background Scheduler
// ---------------------------------------------------------------------------
async function sendPushToUser(
  record: UserPushRecord,
  payload: {
    title: string;
    body: string;
    tag: string;
    tab: string;
    homeworkId?: string;
  }
): Promise<{ successCount: number; failCount: number }> {
  if (record.subscriptions.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  let successCount = 0;
  let failCount = 0;
  const deadHashes = new Set<string>();
  const jsonPayload = JSON.stringify({
    ...payload,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
  });

  await Promise.all(
    record.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          jsonPayload,
          {
            TTL: 60 * 60 * 12, // 12 hours delivery retry window by Apple/FCM
            urgency: 'high',
          }
        );
        sub.lastSuccessAt = new Date().toISOString();
        successCount++;
      } catch (err: unknown) {
        failCount++;
        const statusCode =
          typeof err === 'object' && err !== null && 'statusCode' in err
            ? Number((err as { statusCode?: number }).statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          deadHashes.add(sub.endpointHash);
        } else {
          console.warn(`[WebPush] Delivery error for ${record.uid} (${sub.deviceType}):`, statusCode || err);
        }
      }
    })
  );

  if (deadHashes.size > 0) {
    record.subscriptions = record.subscriptions.filter((s) => !deadHashes.has(s.endpointHash));
  }

  record.recentLogs = [
    {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: payload.title,
      body: payload.body,
      sentAt: new Date().toISOString(),
      successCount,
      failCount,
    },
    ...record.recentLogs,
  ].slice(0, 20);

  schedulePersistStore();
  return { successCount, failCount };
}

let schedulerRunning = false;

async function processUserNotifications(record: UserPushRecord, nowMs: number): Promise<void> {
  const prefs = record.preferences;
  if (!prefs.enabled || record.subscriptions.length === 0) return;

  const tzOffset = prefs.timezoneOffsetMinutes ?? -420;
  const defaultTime = prefs.defaultDueTime || '20:00';
  const activeGlobalRules = prefs.rules.filter((r) => r.enabled);

  // Prune sentKeys older than 14 days
  for (const [k, ts] of Object.entries(record.sentKeys)) {
    if (nowMs - ts > 14 * 24 * 60 * 60_000) {
      delete record.sentKeys[k];
    }
  }

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
    tab: string;
    homeworkId?: string;
  }> = [];

  if (prefs.notifyHomeworks) {
    for (const hw of record.homeworks) {
      if (hw.completed || hw.progress >= 100 || hw.muteNotifications) continue;
      if (!hw.dueDate || hw.dueDate === 'ไม่มีกำหนดส่ง') continue;
      const dueTime = hw.dueTime && /^\d{2}:\d{2}$/.test(hw.dueTime) ? hw.dueTime : defaultTime;
      const dueAtMs = computeDueEpochMs(hw.dueDate, hw.dueTime, defaultTime, tzOffset);
      if (!dueAtMs) continue;
      const hwRules =
        Array.isArray(hw.customReminders) && hw.customReminders.length > 0
          ? hw.customReminders.filter((r) => r.enabled)
          : activeGlobalRules;
      if (hwRules.length === 0) continue;

      jobs.push({
        kind: 'hw',
        id: hw.id,
        titlePrefix: 'การบ้าน',
        subjectOrName: hw.subject || 'การบ้าน',
        detailLine: hw.title ? `เรื่อง: ${hw.title}` : 'กรุณาตรวจสอบรายละเอียดงาน',
        dueDate: hw.dueDate,
        dueTime,
        dueAtMs,
        rules: hwRules,
        tab: 'main',
        homeworkId: hw.id,
      });
    }
  }

  if (prefs.notifyExams && activeGlobalRules.length > 0) {
    for (const exam of record.exams) {
      if (exam.isCompleted || !exam.date) continue;
      const dueTime = exam.startTime && /^\d{2}:\d{2}$/.test(exam.startTime) ? exam.startTime : '08:30';
      const dueAtMs = computeDueEpochMs(exam.date, exam.startTime, '08:30', tzOffset);
      if (!dueAtMs) continue;

      jobs.push({
        kind: 'exam',
        id: exam.id,
        titlePrefix: 'สอบ',
        subjectOrName: `${exam.subject} (${exam.examType || 'สอบ'})`,
        detailLine: 'เตรียมความพร้อมทบทวนบทเรียน',
        dueDate: exam.date,
        dueTime,
        dueAtMs,
        rules: activeGlobalRules,
        tab: 'exam',
      });
    }
  }

  if (prefs.notifyTodos && activeGlobalRules.length > 0) {
    for (const todo of record.todos) {
      if (todo.completed || !todo.date) continue;
      const dueTime = todo.time && /^\d{2}:\d{2}$/.test(todo.time) ? todo.time : defaultTime;
      const dueAtMs = computeDueEpochMs(todo.date, todo.time, defaultTime, tzOffset);
      if (!dueAtMs) continue;

      jobs.push({
        kind: 'todo',
        id: todo.id,
        titlePrefix: 'To Do',
        subjectOrName: todo.title,
        detailLine: 'รายการสิ่งที่ต้องทำตามแผน',
        dueDate: todo.date,
        dueTime,
        dueAtMs,
        rules: activeGlobalRules,
        tab: 'todo',
      });
    }
  }

  for (const job of jobs) {
    for (const rule of job.rules) {
      const leadMs =
        ((rule.days * 24 + rule.hours) * 60 + (rule.minutes || 0)) * 60_000;
      const triggerAtMs = job.dueAtMs - leadMs;

      // Trigger if current time reached triggerAtMs and not older than 15m past dueAtMs
      if (nowMs >= triggerAtMs && nowMs <= job.dueAtMs + 15 * 60_000) {
        const dedupKey = `${job.kind}:${job.id}:${job.dueAtMs}:${rule.days}d${rule.hours}h${rule.minutes || 0}m`;
        if (record.sentKeys[dedupKey]) continue;

        // Mark sent immediately before awaiting network so concurrent cycles won't duplicate
        record.sentKeys[dedupKey] = nowMs;
        schedulePersistStore();

        const remainingStr = formatRemainingThai(job.dueAtMs - nowMs);
        const iconEmoji = job.kind === 'exam' ? '🎓' : job.kind === 'todo' ? '✅' : '📚';
        const title = `${iconEmoji} ${job.titlePrefix}: ${job.subjectOrName} (${remainingStr})`;
        const body = `${job.detailLine}\nกำหนด: ${formatThaiDueDate(job.dueDate, job.dueTime)}`;

        await sendPushToUser(record, {
          title,
          body,
          tag: `${job.kind}-${job.id}-${rule.id}`,
          tab: job.tab,
          homeworkId: job.homeworkId,
        });
      }
    }
  }
}

async function runNotificationSchedulerCycle(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const nowMs = Date.now();
    const records = Object.values(pushStore.users);
    for (const record of records) {
      await processUserNotifications(record, nowMs);
    }
  } catch (err) {
    console.error('[PushScheduler] Cycle error:', err);
  } finally {
    schedulerRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Express App & API Routes
// ---------------------------------------------------------------------------
async function bootstrap(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({
      publicKey: VAPID_PUBLIC_KEY,
      configuredFromEnv: hasEnvVapid,
    });
  });

  // Establish scoped Bearer session for logged-in user
  app.post('/api/push/session', async (req, res) => {
    try {
      const uid = req.body?.uid;
      if (!isValidUid(uid)) {
        res.status(400).json({ error: 'Invalid user identifier' });
        return;
      }

      // Optional verification against Firestore REST API when project config is available
      if (firebaseWebConfig.projectId && firebaseWebConfig.apiKey) {
        const dbId = firebaseWebConfig.firestoreDatabaseId || '(default)';
        const verifyUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
          firebaseWebConfig.projectId
        )}/databases/${encodeURIComponent(dbId)}/documents/users/${encodeURIComponent(
          uid
        )}?key=${encodeURIComponent(firebaseWebConfig.apiKey)}`;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3500);
          const checkRes = await fetch(verifyUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (checkRes.status === 404) {
            res.status(401).json({ error: 'User account not found' });
            return;
          }
        } catch {
          // Graceful fallback if offline or Firestore REST timeout in preview
        }
      }

      const { token, expiresAt } = signSessionToken(uid);
      res.json({ token, expiresAt });
    } catch (err) {
      console.error('[PushSession] Error:', err);
      res.status(500).json({ error: 'Failed to create push session' });
    }
  });

  app.get('/api/push/status', requirePushAuth, (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const record = getOrCreateUserRecord(uid);
    res.json({
      subscribedCount: record.subscriptions.length,
      devices: record.subscriptions.map((s) => ({
        endpointHash: s.endpointHash,
        deviceType: s.deviceType,
        deviceLabel: s.deviceLabel,
        createdAt: s.createdAt,
        lastSuccessAt: s.lastSuccessAt,
      })),
      preferences: record.preferences,
      recentLogs: record.recentLogs,
      vapidPublicKey: VAPID_PUBLIC_KEY,
    });
  });

  app.post('/api/push/subscribe', requirePushAuth, (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const sub = req.body?.subscription;
    if (!sub || typeof sub !== 'object') {
      res.status(400).json({ error: 'Missing push subscription object' });
      return;
    }

    const endpoint = sub.endpoint;
    const p256dh = sub.keys?.p256dh;
    const authKey = sub.keys?.auth;

    if (!isAllowedPushEndpoint(endpoint)) {
      res.status(400).json({ error: 'Unsupported or invalid push service endpoint URL' });
      return;
    }
    if (
      typeof p256dh !== 'string' ||
      p256dh.length < 10 ||
      p256dh.length > 256 ||
      typeof authKey !== 'string' ||
      authKey.length < 8 ||
      authKey.length > 128
    ) {
      res.status(400).json({ error: 'Invalid Web Push encryption keys' });
      return;
    }

    const deviceTypeRaw = req.body?.deviceType;
    const deviceType: 'ios' | 'android' | 'desktop' =
      deviceTypeRaw === 'ios' || deviceTypeRaw === 'android' ? deviceTypeRaw : 'desktop';
    const deviceLabel =
      typeof req.body?.deviceLabel === 'string' && req.body.deviceLabel.trim()
        ? req.body.deviceLabel.trim().slice(0, 80)
        : deviceType === 'ios'
          ? 'iPhone / iPad (PWA)'
          : deviceType === 'android'
            ? 'Android Device'
            : 'Web Browser';

    const record = getOrCreateUserRecord(uid);
    const endpointHash = hashEndpoint(endpoint);
    const existingIdx = record.subscriptions.findIndex((s) => s.endpoint === endpoint);
    const newSub: StoredSubscription = {
      endpoint,
      endpointHash,
      keys: { p256dh, auth: authKey },
      deviceType,
      deviceLabel,
      createdAt:
        existingIdx >= 0 ? record.subscriptions[existingIdx].createdAt : new Date().toISOString(),
      lastSuccessAt:
        existingIdx >= 0 ? record.subscriptions[existingIdx].lastSuccessAt : undefined,
    };

    if (existingIdx >= 0) {
      record.subscriptions[existingIdx] = newSub;
    } else {
      // Limit to 15 devices per account
      record.subscriptions = [newSub, ...record.subscriptions].slice(0, 15);
    }

    if (req.body?.preferences) {
      record.preferences = sanitizePreferences(req.body.preferences, record.preferences);
    } else {
      record.preferences.enabled = true;
    }

    record.updatedAt = new Date().toISOString();
    schedulePersistStore();

    res.json({
      ok: true,
      endpointHash,
      subscribedCount: record.subscriptions.length,
      preferences: record.preferences,
    });
  });

  app.post('/api/push/unsubscribe', requirePushAuth, (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const record = getOrCreateUserRecord(uid);
    const endpoint = req.body?.endpoint;
    const all = Boolean(req.body?.all);

    if (all) {
      record.subscriptions = [];
      record.preferences.enabled = false;
    } else if (typeof endpoint === 'string' && endpoint.length > 0) {
      record.subscriptions = record.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (record.subscriptions.length === 0) {
        record.preferences.enabled = false;
      }
    }

    record.updatedAt = new Date().toISOString();
    schedulePersistStore();

    res.json({
      ok: true,
      subscribedCount: record.subscriptions.length,
      preferences: record.preferences,
    });
  });

  app.post('/api/push/preferences', requirePushAuth, async (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const record = getOrCreateUserRecord(uid);
    record.preferences = sanitizePreferences(req.body?.preferences, record.preferences);
    record.updatedAt = new Date().toISOString();
    schedulePersistStore();

    await processUserNotifications(record, Date.now());
    res.json({ ok: true, preferences: record.preferences });
  });

  app.post('/api/push/sync-tasks', requirePushAuth, async (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const record = getOrCreateUserRecord(uid);

    if (Array.isArray(req.body?.homeworks)) {
      record.homeworks = req.body.homeworks.slice(0, 500).map((hw: Record<string, unknown>) => ({
        id: String(hw.id || '').slice(0, 128),
        subject: String(hw.subject || '').slice(0, 150),
        title: typeof hw.title === 'string' ? hw.title.slice(0, 200) : undefined,
        dueDate: String(hw.dueDate || '').slice(0, 32),
        dueTime: typeof hw.dueTime === 'string' ? hw.dueTime.slice(0, 32) : undefined,
        progress: Number(hw.progress) || 0,
        completed: Boolean(hw.completed),
        priority: typeof hw.priority === 'string' ? hw.priority.slice(0, 32) : undefined,
        customReminders: Array.isArray(hw.customReminders)
          ? sanitizeRules(hw.customReminders)
          : undefined,
        muteNotifications: Boolean(hw.muteNotifications),
      }));
    }

    if (Array.isArray(req.body?.exams)) {
      record.exams = req.body.exams.slice(0, 300).map((ex: Record<string, unknown>) => ({
        id: String(ex.id || '').slice(0, 128),
        subject: String(ex.subject || '').slice(0, 150),
        examType: typeof ex.examType === 'string' ? ex.examType.slice(0, 60) : undefined,
        date: String(ex.date || '').slice(0, 32),
        startTime: typeof ex.startTime === 'string' ? ex.startTime.slice(0, 16) : undefined,
        isCompleted: Boolean(ex.isCompleted),
      }));
    }

    if (Array.isArray(req.body?.todos)) {
      record.todos = req.body.todos.slice(0, 500).map((td: Record<string, unknown>) => ({
        id: String(td.id || '').slice(0, 128),
        title: String(td.title || '').slice(0, 200),
        date: String(td.date || '').slice(0, 32),
        time: typeof td.time === 'string' ? td.time.slice(0, 16) : undefined,
        completed: Boolean(td.completed),
        type: typeof td.type === 'string' ? td.type.slice(0, 32) : undefined,
      }));
    }

    if (req.body?.preferences) {
      record.preferences = sanitizePreferences(req.body.preferences, record.preferences);
    }

    record.updatedAt = new Date().toISOString();
    schedulePersistStore();

    await processUserNotifications(record, Date.now());
    res.json({
      ok: true,
      homeworksCount: record.homeworks.length,
      examsCount: record.exams.length,
      todosCount: record.todos.length,
    });
  });

  app.post('/api/push/test', requirePushAuth, async (req: AuthedRequest, res) => {
    const uid = req.authUid!;
    const record = getOrCreateUserRecord(uid);
    if (record.subscriptions.length === 0) {
      res.status(400).json({ error: 'ยังไม่มีอุปกรณ์ที่ลงทะเบียนรับแจ้งเตือน กรุณากดเปิดรับแจ้งเตือนก่อน' });
      return;
    }

    const delaySeconds = Math.max(0, Math.min(30, Math.floor(Number(req.body?.delaySeconds) || 0)));
    const title =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : '🔔 ทดสอบแจ้งเตือนการบ้าน (Web Push)';
    const body =
      typeof req.body?.body === 'string' && req.body.body.trim()
        ? req.body.body.trim().slice(0, 240)
        : 'ระบบแจ้งเตือนทำงานปกติ! เซิร์ฟเวอร์จะส่งแจ้งเตือนงานใกล้ครบกำหนดให้คุณแม้ปิดหน้าเว็บหรือพักหน้าจอมือถืออยู่';

    if (delaySeconds > 0) {
      setTimeout(() => {
        void sendPushToUser(record, {
          title,
          body,
          tag: `test-push-${Date.now()}`,
          tab: 'main',
        });
      }, delaySeconds * 1000);
      res.json({ ok: true, scheduledInSeconds: delaySeconds });
      return;
    }

    const result = await sendPushToUser(record, {
      title,
      body,
      tag: `test-push-${Date.now()}`,
      tab: 'main',
    });
    res.json({ ok: true, ...result });
  });

  // Start background Web Push scheduler (runs every 30s)
  setInterval(() => {
    void runNotificationSchedulerCycle();
  }, 30_000);

  // Vite dev middleware or static production serving
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
      },
      appType: 'spa',
    });

    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result) {
          next();
          return;
        }
        const cleanCode = result.code
          .replace(
            'transport.connect(createHMRHandler(handleMessage));',
            '/* HMR disabled */'
          )
          .replaceAll(
            'throw new Error("send was called before connect");',
            'return;'
          )
          .replaceAll(
            'throw new Error("invoke was called before connect");',
            'return;'
          );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        if (result.etag) {
          res.setHeader('ETag', result.etag);
        }
        res.send(cleanCode);
      } catch (err) {
        next(err);
      }
    });

    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`);
  });
}

void bootstrap();
