import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Laptop,
  Loader2,
  Plus,
  Send,
  Share,
  Smartphone,
  Sparkles,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import {
  ExamSchedule,
  Homework,
  NotificationPreferences,
  PushDispatchLogEntry,
  RegisteredPushDevice,
  ReminderRule,
  TodoItem,
} from '../types';
import {
  computeUpcomingPushPreview,
  fetchPushStatus,
  formatRuleLabel,
  getCurrentBrowserSubscription,
  isRunningInIframe,
  sendTestPushNotification,
  subscribeDeviceToWebPush,
  unsubscribeDeviceFromWebPush,
} from '../lib/pushClient';
import { detectDeviceEnvironment, usePWAInstall } from '../lib/usePWAInstall';

interface NotificationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  preferences: NotificationPreferences;
  onUpdatePreferences: (next: NotificationPreferences) => Promise<void> | void;
  homeworks: Homework[];
  exams: ExamSchedule[];
  todos: TodoItem[];
  onNotifyToast?: (
    title: string,
    message: string,
    type?: 'success' | 'info' | 'warning' | 'error'
  ) => void;
}

const QUICK_PRESETS: Array<{ id: string; days: number; hours: number; minutes: number; label: string }> = [
  { id: 'preset_2d', days: 2, hours: 0, minutes: 0, label: '2 วัน' },
  { id: 'preset_1d', days: 1, hours: 0, minutes: 0, label: '1 วัน' },
  { id: 'preset_12h', days: 0, hours: 12, minutes: 0, label: '12 ชม.' },
  { id: 'preset_6h', days: 0, hours: 6, minutes: 0, label: '6 ชม.' },
  { id: 'preset_3h', days: 0, hours: 3, minutes: 0, label: '3 ชม.' },
  { id: 'preset_1h', days: 0, hours: 1, minutes: 0, label: '1 ชม.' },
  { id: 'preset_30m', days: 0, hours: 0, minutes: 30, label: '30 นาที' },
  { id: 'preset_0', days: 0, hours: 0, minutes: 0, label: 'เมื่อถึงเวลาส่ง' },
];

const DEFAULT_TIME_CHOICES = ['08:00', '12:00', '18:00', '20:00', '23:59'];

export const NotificationSettingsModal: React.FC<NotificationSettingsModalProps> = ({
  isOpen,
  onClose,
  userId,
  preferences,
  onUpdatePreferences,
  homeworks,
  exams,
  todos,
  onNotifyToast,
}) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const [env, setEnv] = useState(() => detectDeviceEnvironment());
  const [inIframe, setInIframe] = useState(() => isRunningInIframe());
  const [permissionState, setPermissionState] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [hasBrowserSub, setHasBrowserSub] = useState(false);

  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [delayedCountdown, setDelayedCountdown] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [devices, setDevices] = useState<RegisteredPushDevice[]>([]);
  const [recentLogs, setRecentLogs] = useState<PushDispatchLogEntry[]>([]);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);

  // Custom rule builder inputs
  const [customDays, setCustomDays] = useState<number>(1);
  const [customHours, setCustomHours] = useState<number>(0);
  const [customMinutes, setCustomMinutes] = useState<number>(0);

  useEffect(() => {
    if (!isOpen) return;
    setEnv(detectDeviceEnvironment());
    setInIframe(isRunningInIframe());
    if (typeof Notification !== 'undefined') {
      setPermissionState(Notification.permission);
    }
    setStatusError(null);

    const loadStatus = async () => {
      setIsLoadingStatus(true);
      try {
        const sub = await getCurrentBrowserSubscription();
        setHasBrowserSub(Boolean(sub));
        const serverStatus = await fetchPushStatus(userId);
        setDevices(serverStatus.devices || []);
        setRecentLogs(serverStatus.recentLogs || []);
      } catch (err) {
        console.warn('Could not load push status:', err);
      } finally {
        setIsLoadingStatus(false);
      }
    };
    void loadStatus();
  }, [isOpen, userId]);

  useEffect(() => {
    if (delayedCountdown === null) return;
    if (delayedCountdown <= 0) {
      setDelayedCountdown(null);
      setTimeout(async () => {
        try {
          const serverStatus = await fetchPushStatus(userId);
          setRecentLogs(serverStatus.recentLogs || []);
        } catch {
          // ignore
        }
      }, 1500);
      return;
    }
    const timer = setTimeout(() => {
      setDelayedCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [delayedCountdown, userId]);

  const upcomingPreview = useMemo(
    () => computeUpcomingPushPreview(homeworks, exams, todos, preferences),
    [homeworks, exams, todos, preferences]
  );

  if (!isOpen) return null;

  const isPushReadyOnDevice =
    preferences.enabled && hasBrowserSub && permissionState === 'granted';

  const handleEnablePush = async () => {
    setStatusError(null);
    setIsSubscribing(true);
    try {
      const nextPrefs: NotificationPreferences = {
        ...preferences,
        enabled: true,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        updatedAt: new Date().toISOString(),
      };
      await subscribeDeviceToWebPush(userId, nextPrefs);
      setPermissionState(
        typeof Notification !== 'undefined' ? Notification.permission : 'granted'
      );
      setHasBrowserSub(true);
      await onUpdatePreferences(nextPrefs);

      const serverStatus = await fetchPushStatus(userId);
      setDevices(serverStatus.devices || []);
      setRecentLogs(serverStatus.recentLogs || []);

      onNotifyToast?.(
        'เปิดรับการแจ้งเตือนอัตโนมัติสำเร็จ!',
        'อุปกรณ์นี้ลงทะเบียนรับ Web Push เรียบร้อย เซิร์ฟเวอร์จะส่งแจ้งเตือนให้แม้ปิดหน้าเว็บ',
        'success'
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'ไม่สามารถเปิดใช้งาน Web Push ได้';
      setStatusError(msg);
      if (typeof Notification !== 'undefined') {
        setPermissionState(Notification.permission);
      }
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleDisablePush = async () => {
    setStatusError(null);
    setIsSubscribing(true);
    try {
      await unsubscribeDeviceFromWebPush(userId);
      setHasBrowserSub(false);
      const nextPrefs: NotificationPreferences = {
        ...preferences,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      await onUpdatePreferences(nextPrefs);
      const serverStatus = await fetchPushStatus(userId).catch(() => null);
      if (serverStatus) {
        setDevices(serverStatus.devices || []);
      }
      onNotifyToast?.(
        'ปิดการแจ้งเตือนอุปกรณ์นี้แล้ว',
        'คุณสามารถกลับมาเปิดใช้งานใหม่ได้ตลอดเวลา',
        'info'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถปิดรับแจ้งเตือนได้';
      setStatusError(msg);
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleTestPush = async (delaySeconds: number) => {
    setStatusError(null);
    setIsTesting(true);
    try {
      await sendTestPushNotification(userId, delaySeconds);
      if (delaySeconds > 0) {
        setDelayedCountdown(delaySeconds);
        onNotifyToast?.(
          `ตั้งเวลาทดสอบใน ${delaySeconds} วินาที`,
          'ลองกดพักหน้าจอมือถือหรือสลับแท็บได้เลย การแจ้งเตือนจะเด้งเข้ามาอัตโนมัติ',
          'info'
        );
      } else {
        onNotifyToast?.(
          'ส่งแจ้งเตือนทดสอบแล้ว!',
          'ตรวจสอบแถบแจ้งเตือนบนอุปกรณ์ของคุณ',
          'success'
        );
        const serverStatus = await fetchPushStatus(userId).catch(() => null);
        if (serverStatus) setRecentLogs(serverStatus.recentLogs || []);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ';
      setStatusError(msg);
    } finally {
      setIsTesting(false);
    }
  };

  const updatePrefs = (updater: (prev: NotificationPreferences) => NotificationPreferences) => {
    const next = {
      ...updater(preferences),
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      updatedAt: new Date().toISOString(),
    };
    void onUpdatePreferences(next);
  };

  const handleToggleRule = (ruleId: string) => {
    updatePrefs((prev) => ({
      ...prev,
      rules: prev.rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)),
    }));
  };

  const handleDeleteRule = (ruleId: string) => {
    updatePrefs((prev) => ({
      ...prev,
      rules: prev.rules.filter((r) => r.id !== ruleId),
    }));
  };

  const hasExactRule = (days: number, hours: number, minutes: number) =>
    preferences.rules.some(
      (r) => r.days === days && r.hours === hours && (r.minutes || 0) === minutes
    );

  const handleAddRule = (days: number, hours: number, minutes: number) => {
    const d = Math.max(0, Math.min(365, Math.floor(days || 0)));
    const h = Math.max(0, Math.min(23, Math.floor(hours || 0)));
    const m = Math.max(0, Math.min(59, Math.floor(minutes || 0)));

    const existing = preferences.rules.find(
      (r) => r.days === d && r.hours === h && (r.minutes || 0) === m
    );
    if (existing) {
      if (!existing.enabled) {
        handleToggleRule(existing.id);
      }
      return;
    }

    const newRule: ReminderRule = {
      id: `rule_${d}d_${h}h_${m}m_${Date.now().toString(36)}`,
      days: d,
      hours: h,
      minutes: m,
      enabled: true,
      label: formatRuleLabel({ days: d, hours: h, minutes: m }),
    };

    updatePrefs((prev) => {
      const updated = [...prev.rules, newRule];
      updated.sort((a, b) => {
        const aMins = (a.days * 24 + a.hours) * 60 + (a.minutes || 0);
        const bMins = (b.days * 24 + b.hours) * 60 + (b.minutes || 0);
        return bMins - aMins;
      });
      return { ...prev, rules: updated };
    });
  };

  const formatNotifyDateTime = (d: Date) =>
    d.toLocaleString('th-TH', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' น.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/75 backdrop-blur-md animate-fadeIn">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="relative w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh] z-10 animate-pop">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200/80 dark:border-slate-800 bg-gradient-to-r from-sky-50 via-white to-indigo-50/50 dark:from-slate-850 dark:via-slate-900 dark:to-slate-850 flex items-center justify-between gap-3">
          <div className="flex items-center space-x-3 min-w-0">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-md ${
                isPushReadyOnDevice
                  ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-500/25'
                  : 'bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-sky-500/25'
              }`}
            >
              {isPushReadyOnDevice ? (
                <BellRing className="w-5 h-5" />
              ) : (
                <Bell className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-bold font-heading text-slate-900 dark:text-slate-100 truncate">
                ตั้งค่าการแจ้งเตือน (Web Push)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                แจ้งเตือนงานอัตโนมัติทั้ง iOS & Android แม้ปิดแท็บหรือพักหน้าจอ
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
            aria-label="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {/* Section 1: Device Push Status & Direct 1-Click Enable Switch */}
          <div
            className={`rounded-2xl border p-4 space-y-3 ${
              isPushReadyOnDevice
                ? 'bg-emerald-50/70 dark:bg-emerald-950/25 border-emerald-200 dark:border-emerald-800/80'
                : 'bg-slate-50 dark:bg-slate-850 border-slate-200 dark:border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start space-x-3 flex-1 min-w-[200px]">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                    isPushReadyOnDevice
                      ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300'
                      : 'bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300'
                  }`}
                >
                  {env.isIOS || env.isAndroid ? (
                    <Smartphone className="w-5 h-5" />
                  ) : (
                    <Laptop className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
                      {isPushReadyOnDevice
                        ? 'เปิดการแจ้งเตือนอยู่ (พร้อมทำงาน)'
                        : 'เปิดรับการแจ้งเตือนอัตโนมัติ'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                    {isPushReadyOnDevice
                      ? 'เซิร์ฟเวอร์จะส่งการแจ้งเตือน (Web Push) ให้ตามเวลาที่กำหนด แม้คุณจะปิดเบราว์เซอร์หรือพักหน้าจอ'
                      : 'กดสวิตช์หรือปุ่มด้านขวา เพื่อให้เว็บขออนุญาตแจ้งเตือนจากเบราว์เซอร์ทันที'}
                  </p>
                </div>
              </div>

              {/* Always-clickable Switch + Primary Action Button */}
              <div className="flex items-center space-x-2.5 shrink-0">
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPushReadyOnDevice}
                  aria-label="เปิดหรือปิดการแจ้งเตือน"
                  disabled={isSubscribing}
                  onClick={() =>
                    void (isPushReadyOnDevice ? handleDisablePush() : handleEnablePush())
                  }
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-sky-500/40 disabled:opacity-50 ${
                    isPushReadyOnDevice
                      ? 'bg-emerald-500'
                      : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${
                      isPushReadyOnDevice ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>

                {isPushReadyOnDevice ? (
                  <button
                    type="button"
                    onClick={handleDisablePush}
                    disabled={isSubscribing}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isSubscribing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <BellOff className="w-3.5 h-3.5" />
                    )}
                    <span>ปิดแจ้งเตือน</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleEnablePush}
                    disabled={isSubscribing}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-700 hover:to-indigo-700 text-white shadow-sm shadow-sky-600/25 transition-all flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isSubscribing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <BellRing className="w-3.5 h-3.5" />
                    )}
                    <span>{isSubscribing ? 'กำลังขออนุญาต...' : 'กดเปิดและขออนุญาตแจ้งเตือน'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Iframe Warning / Open in Full Tab Helper */}
            {inIframe && !isPushReadyOnDevice && (
              <div className="rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 p-3 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-sky-900 dark:text-sky-200 flex-1 min-w-[200px]">
                  หากกดเปิดแล้วเบราว์เซอร์ไม่ขึ้นหน้าต่างขออนุญาต (เนื่องจากอยู่ในหน้าต่างพรีวิว) สามารถเปิดเว็บในแท็บเต็มเพื่อกดอนุญาตได้ทันที
                </p>
                <a
                  href={typeof window !== 'undefined' ? window.location.href : '/'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center space-x-1.5 shrink-0 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>เปิดในแท็บใหม่</span>
                </a>
              </div>
            )}

            {/* iOS Install Guide (Safari 16.4+ requires Home Screen PWA for Web Push) */}
            {env.needsIOSInstall && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-3.5 space-y-2">
                <div className="flex items-center space-x-2 text-amber-800 dark:text-amber-300 font-bold text-xs">
                  <Share className="w-4 h-4 shrink-0" />
                  <span>วิธีเปิด Web Push บน iPhone / iPad (iOS 16.4 ขึ้นไป)</span>
                </div>
                <ol className="text-xs text-amber-900/90 dark:text-amber-200/90 space-y-1 list-decimal list-inside leading-relaxed">
                  <li>
                    เปิดเว็บนี้ด้วยเบราว์เซอร์ <strong>Safari</strong> แล้วกดปุ่ม{' '}
                    <strong>แชร์ (Share)</strong> ที่แถบด้านล่าง
                  </li>
                  <li>
                    เลื่อนลงแล้วเลือก <strong>"เพิ่มไปยังหน้าจอโฮม" (Add to Home Screen)</strong>
                  </li>
                  <li>
                    กดเปิดแอปจากไอคอนบนหน้าจอโฮม แล้วกดปุ่ม <strong>เปิดและขออนุญาตแจ้งเตือน</strong> ด้านบนได้เลย
                  </li>
                </ol>
              </div>
            )}

            {/* Android / Desktop PWA Install Prompt */}
            {!env.isIOS && !isInstalled && isInstallable && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 p-3">
                <div className="text-xs text-sky-900 dark:text-sky-200">
                  <strong className="block font-bold">ติดตั้งเป็นแอปลงหน้าจอมือถือ (PWA)</strong>
                  <span className="text-[11px] opacity-85">
                    ช่วยให้เปิดใช้งานเร็วและรับแจ้งเตือนบน Android / คอมพิวเตอร์ได้เสถียรยิ่งขึ้น
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void install()}
                  className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center space-x-1.5 shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>ติดตั้งแอป</span>
                </button>
              </div>
            )}

            {/* Permission Denied Warning */}
            {permissionState === 'denied' && (
              <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 p-3 flex items-start space-x-2 text-xs text-rose-700 dark:text-rose-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <strong>สิทธิ์การแจ้งเตือนถูกปิดไว้:</strong> กรุณากดที่ไอคอนรูปกุญแจ/ตั้งค่าข้างแถบ URL ของเบราว์เซอร์ แล้วเปลี่ยน Notifications เป็น "อนุญาต (Allow)" จากนั้นกดปุ่มเปิดแจ้งเตือนอีกครั้ง
                </div>
              </div>
            )}

            {/* Status Error */}
            {statusError && (
              <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 p-3 text-xs text-rose-700 dark:text-rose-300 flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{statusError}</span>
              </div>
            )}

            {/* Test Push Buttons */}
            {isPushReadyOnDevice && (
              <div className="pt-2 border-t border-emerald-200/70 dark:border-emerald-800/50 flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center space-x-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>ทดสอบรับแจ้งเตือนจากเซิร์ฟเวอร์:</span>
                </span>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    disabled={isTesting}
                    onClick={() => void handleTestPush(0)}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 transition-colors flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>ส่งทันที</span>
                  </button>
                  <button
                    type="button"
                    disabled={isTesting || delayedCountdown !== null}
                    onClick={() => void handleTestPush(5)}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center space-x-1.5 cursor-pointer disabled:opacity-70"
                  >
                    <Timer className="w-3.5 h-3.5" />
                    <span>
                      {delayedCountdown !== null
                        ? `จะส่งใน ${delayedCountdown} วิ (ลองพักจอได้เลย)...`
                        : 'ทดสอบส่งใน 5 วินาที (ปิดแท็บ/พักจอลองได้)'}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Section 2: Lead-time Reminder Rules */}
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
            <div>
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center space-x-2">
                <Clock className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                <span>เลือกเวลาแจ้งเตือนล่วงหน้าก่อนกำหนดส่ง</span>
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                เลือกเปิด/ปิดได้หลายช่วงเวลา เช่น ก่อนส่ง 1 วัน หรือกำหนดเป็น วัน/ชั่วโมง/นาที เองได้
              </p>
            </div>

            {/* Active / Configured Rules List */}
            <div className="space-y-2">
              {preferences.rules.length === 0 ? (
                <div className="text-xs text-slate-400 dark:text-slate-500 py-3 text-center border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                  ยังไม่มีเวลาแจ้งเตือน กดเลือกจากตัวเลือกด่วนหรือกำหนดเองด้านล่าง
                </div>
              ) : (
                preferences.rules.map((rule) => (
                  <div
                    key={rule.id}
                    className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl border transition-colors ${
                      rule.enabled
                        ? 'bg-sky-50/70 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800'
                        : 'bg-slate-50 dark:bg-slate-850 border-slate-200/80 dark:border-slate-800 opacity-75'
                    }`}
                  >
                    <label className="flex items-center space-x-3 cursor-pointer flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => handleToggleRule(rule.id)}
                        className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 focus:ring-sky-500 cursor-pointer"
                      />
                      <div className="min-w-0">
                        <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 block truncate">
                          {formatRuleLabel(rule)}
                        </span>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDeleteRule(rule.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                      title="ลบเวลานี้"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Quick Presets */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block">
                เพิ่มเวลาแจ้งเตือนยอดนิยม:
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {QUICK_PRESETS.map((preset) => {
                  const exists = hasExactRule(preset.days, preset.hours, preset.minutes);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        handleAddRule(preset.days, preset.hours, preset.minutes)
                      }
                      className={`px-2.5 py-2 rounded-xl text-xs font-semibold border transition-colors flex items-center justify-center space-x-1 cursor-pointer ${
                        exists
                          ? 'bg-sky-100 dark:bg-sky-950/60 border-sky-300 dark:border-sky-700 text-sky-800 dark:text-sky-200'
                          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-sky-50 dark:hover:bg-slate-700'
                      }`}
                    >
                      {exists ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
                      ) : (
                        <Plus className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom Days / Hours / Minutes Builder */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block">
                กำหนดเวลาล่วงหน้าเอง (วัน / ชั่วโมง / นาที):
              </span>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 items-end">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                    วัน
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={customDays}
                    onChange={(e) => setCustomDays(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
                    className="w-full px-2.5 py-1.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                    ชั่วโมง
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={customHours}
                    onChange={(e) => setCustomHours(Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
                    className="w-full px-2.5 py-1.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                    นาที
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
                    className="w-full px-2.5 py-1.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleAddRule(customDays, customHours, customMinutes)}
                  className="col-span-3 sm:col-span-1 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center justify-center space-x-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>เพิ่มเวลา</span>
                </button>
              </div>
            </div>
          </div>

          {/* Section 3: Scope & Default Due Time */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Notification Scope */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                ประเภทงานที่จะแจ้งเตือน
              </h4>
              <label className="flex items-center justify-between py-1 cursor-pointer">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  📚 การบ้านที่ยังไม่เสร็จ
                </span>
                <input
                  type="checkbox"
                  checked={preferences.notifyHomeworks}
                  onChange={(e) =>
                    updatePrefs((prev) => ({ ...prev, notifyHomeworks: e.target.checked }))
                  }
                  className="w-4 h-4 rounded text-sky-600 focus:ring-sky-500 cursor-pointer"
                />
              </label>
              <label className="flex items-center justify-between py-1 cursor-pointer">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  🎓 ตารางสอบ
                </span>
                <input
                  type="checkbox"
                  checked={preferences.notifyExams}
                  onChange={(e) =>
                    updatePrefs((prev) => ({ ...prev, notifyExams: e.target.checked }))
                  }
                  className="w-4 h-4 rounded text-sky-600 focus:ring-sky-500 cursor-pointer"
                />
              </label>
              <label className="flex items-center justify-between py-1 cursor-pointer">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  ✅ สิ่งที่ต้องทำ (To Do List)
                </span>
                <input
                  type="checkbox"
                  checked={preferences.notifyTodos}
                  onChange={(e) =>
                    updatePrefs((prev) => ({ ...prev, notifyTodos: e.target.checked }))
                  }
                  className="w-4 h-4 rounded text-sky-600 focus:ring-sky-500 cursor-pointer"
                />
              </label>
            </div>

            {/* Fallback Default Due Time */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                เวลาอ้างอิง (กรณีงานไม่ได้ระบุเวลาส่ง)
              </h4>
              <div className="flex items-center space-x-2">
                <input
                  type="time"
                  value={preferences.defaultDueTime || '20:00'}
                  onChange={(e) =>
                    updatePrefs((prev) => ({
                      ...prev,
                      defaultDueTime: e.target.value || '20:00',
                    }))
                  }
                  className="px-3 py-1.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-semibold"
                />
                <span className="text-xs text-slate-500 dark:text-slate-400">น.</span>
              </div>
              <div className="grid grid-cols-5 gap-1.5 pt-1">
                {DEFAULT_TIME_CHOICES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      updatePrefs((prev) => ({ ...prev, defaultDueTime: t }))
                    }
                    className={`py-1 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer ${
                      (preferences.defaultDueTime || '20:00') === t
                        ? 'bg-sky-600 text-white border-sky-600'
                        : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section 4: Upcoming Scheduled Notifications Preview */}
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-850/60 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                คิวแจ้งเตือนอัตโนมัติที่กำลังจะถึง ({upcomingPreview.length})
              </h4>
              <span className="text-[11px] text-slate-400">คำนวณตามการตั้งค่าปัจจุบัน</span>
            </div>

            {upcomingPreview.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
                ยังไม่มีงานค้างที่มีกำหนดส่งตรงกับเวลาแจ้งเตือนในขณะนี้
              </p>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {upcomingPreview.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-xl px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 dark:text-slate-100 truncate">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {item.ruleLabel} • ส่ง {item.dueLabel}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                        item.isDueSoon
                          ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                          : 'bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300'
                      }`}
                    >
                      {item.isDueSoon ? 'พร้อมส่งรอบถัดไป' : formatNotifyDateTime(item.notifyAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 5: Connected Devices & Recent Dispatch Logs */}
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide">
                อุปกรณ์ที่ผูกแจ้งเตือนกับบัญชีนี้ ({devices.length})
              </h4>
              {isLoadingStatus && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />}
            </div>

            {devices.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-slate-500">
                ยังไม่มีอุปกรณ์ที่ลงทะเบียนรับแจ้งเตือน
              </p>
            ) : (
              <div className="space-y-1.5">
                {devices.map((dev) => (
                  <div
                    key={dev.endpointHash}
                    className="flex items-center justify-between text-xs bg-slate-50 dark:bg-slate-850 px-3 py-2 rounded-xl border border-slate-200/70 dark:border-slate-800"
                  >
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      {dev.deviceLabel}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {dev.lastSuccessAt
                        ? `ส่งล่าสุด ${new Date(dev.lastSuccessAt).toLocaleTimeString('th-TH', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                        : 'พร้อมรับแจ้งเตือน'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {recentLogs.length > 0 && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block">
                  ประวัติการส่งจากเซิร์ฟเวอร์ล่าสุด:
                </span>
                {recentLogs.slice(0, 4).map((log) => (
                  <div
                    key={log.id}
                    className="text-[11px] flex items-center justify-between gap-2 text-slate-600 dark:text-slate-300 bg-slate-50/60 dark:bg-slate-850/60 px-2.5 py-1.5 rounded-lg"
                  >
                    <span className="truncate font-medium">{log.title}</span>
                    <span className="shrink-0 text-slate-400">
                      {new Date(log.sentAt).toLocaleTimeString('th-TH', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      ({log.successCount} เครื่อง)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 sm:p-4 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-850/70 flex items-center justify-between">
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            บันทึกการตั้งค่าและซิงค์กับเซิร์ฟเวอร์อัตโนมัติ
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 dark:bg-sky-600 hover:bg-slate-900 dark:hover:bg-sky-700 text-white text-xs font-bold cursor-pointer transition-colors"
          >
            เสร็จสิ้น
          </button>
        </div>
      </div>
    </div>
  );
};
