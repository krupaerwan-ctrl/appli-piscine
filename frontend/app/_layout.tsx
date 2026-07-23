import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { LogBox, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";

LogBox.ignoreAllLogs(true);

// ---------- MODULE SCOPE (required by Emergent Push Notifications playbook) ----------
// 1. Foreground handler — controls how push renders while app is open.
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
// 2. Android channel — MUST be created at module scope so it exists before
// any push arrives (channel props are frozen after first creation).
if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "PoolKiosk – Alertes",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
    lightColor: "#0ea5e9",
  });
}

// Keep the native splash visible from cold start until icon fonts register.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const router = useRouter();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  // ---- Push notification tap handling ----
  useEffect(() => {
    if (Platform.OS === "web") return;

    // Warm tap (app open when notification tapped)
    const tapSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data: any = response.notification.request.content.data || {};
        const url = data.deeplink || data.action_url;
        if (!url) return;
        if (url.startsWith("http")) Linking.openURL(url);
        else router.push(url);
      },
    );

    // Cold-start tap (user tapped notification while app was killed)
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data: any = response.notification.request.content.data || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (url.startsWith("http")) Linking.openURL(url);
      else router.push(url);
    });

    // Weekly nudge for users who denied notification permission
    (async () => {
      try {
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (status !== "denied" || canAskAgain) return;
        const lastNudge = await AsyncStorage.getItem("pushNudgeAt");
        const oneWeek = 7 * 24 * 60 * 60 * 1000;
        if (lastNudge && Date.now() - Number(lastNudge) <= oneWeek) return;
        // Fire-and-forget — the app UI shows its own inline banner.
        await AsyncStorage.setItem("pushNudgeAt", String(Date.now()));
      } catch { /* ignore */ }
    })();

    return () => { tapSub.remove(); };
  }, [router]);

  if (!loaded && !error) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
