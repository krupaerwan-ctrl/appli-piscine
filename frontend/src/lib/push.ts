// Push notifications registration for PoolKiosk mobile.
// Uses Emergent-managed push (SuprSend relay) — see integration playbook.
import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { v4 as uuid } from "./uuid";

const USER_ID_KEY = "poolkiosk_user_id";

async function getOrCreateUserId(): Promise<string> {
  let uid = await AsyncStorage.getItem(USER_ID_KEY);
  if (!uid) {
    uid = uuid();
    await AsyncStorage.setItem(USER_ID_KEY, uid);
  }
  return uid;
}

export async function registerForPushNotifications(
  backendUrl: string,
): Promise<{ status: "granted" | "denied" | "web" | "unsupported"; user_id?: string }> {
  if (Platform.OS === "web") return { status: "web" };
  if (!Device.isDevice) return { status: "unsupported" };

  // Ask permission before token — never block app flow if user denies.
  const perm = await Notifications.getPermissionsAsync();
  let finalStatus = perm.status;
  if (finalStatus !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    finalStatus = req.status;
  }
  if (finalStatus !== "granted") return { status: "denied" };

  try {
    const tokenResp = await Notifications.getDevicePushTokenAsync();
    const user_id = await getOrCreateUserId();
    await fetch(`${backendUrl}/api/register-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id,
        platform: Platform.OS,
        device_token: tokenResp.data,
      }),
    });
    return { status: "granted", user_id };
  } catch (e) {
    console.warn("registerForPushNotifications failed", e);
    return { status: "denied" };
  }
}

/** React hook that registers once per mount, then never blocks the UI. */
export function usePushRegistration(backendUrl: string) {
  useEffect(() => {
    if (Platform.OS === "web") return;
    registerForPushNotifications(backendUrl).catch(() => {});
  }, [backendUrl]);
}
