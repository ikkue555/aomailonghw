import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function detectDeviceEnvironment() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isIOS: false,
      isAndroid: false,
      isStandalone: false,
      supportsWebPush: false,
      needsIOSInstall: false,
    };
  }

  const ua = navigator.userAgent.toLowerCase();
  const isIOS =
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/.test(ua);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  const supportsWebPush =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  return {
    isIOS,
    isAndroid,
    isStandalone,
    supportsWebPush,
    needsIOSInstall: isIOS && !isStandalone,
  };
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    const env = detectDeviceEnvironment();
    setIsInstalled(env.isStandalone);
    setIsIOS(env.isIOS);
    setIsAndroid(env.isAndroid);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    isIOS,
    isAndroid,
    install,
  };
}
