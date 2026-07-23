import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Switch, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Props = { settings: any; onSaved: (s: any) => void };

const FIELDS: { key: string; label: string; unit?: string }[] = [
  { key: "temp_target", label: "Consigne température", unit: "°C" },
  { key: "ph_min", label: "pH min" },
  { key: "ph_max", label: "pH max" },
  { key: "orp_min", label: "Redox min", unit: "mV" },
  { key: "orp_max", label: "Redox max", unit: "mV" },
  { key: "salinity_min", label: "Salinité min", unit: "ppm" },
  { key: "salinity_max", label: "Salinité max", unit: "ppm" },
  { key: "pressure_min", label: "Pression min", unit: "bar" },
  { key: "pressure_max", label: "Pression max", unit: "bar" },
  { key: "screen_sleep_minutes", label: "Mise en veille écran", unit: "min" },
];

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

async function post(path: string) {
  const r = await fetch(`${BASE}/api${path}`, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function get(path: string) {
  const r = await fetch(`${BASE}/api${path}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export const SettingsScreen: React.FC<Props> = ({ settings, onSaved }) => {
  const [state, setState] = useState<any>(settings || {});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Update state
  const [updateState, setUpdateState] = useState<string>("idle");
  const [updateLog, setUpdateLog] = useState<string>("");
  const [confirmMode, setConfirmMode] = useState<null | "online" | "usb" | "exit">(null);
  const [reloadCountdown, setReloadCountdown] = useState<number | null>(null);
  const pollRef = useRef<any>(null);
  const logScroll = useRef<any>(null);
  const prevStateRef = useRef<string>("idle");

  async function save() {
    setSaving(true);
    try {
      const payload: any = {};
      FIELDS.forEach((f) => (payload[f.key] = Number(state[f.key])));
      payload.pressure_auto_cutoff = state.pressure_auto_cutoff;
      payload.auto_filtration = state.auto_filtration;
      const s = await api.updateSettings(payload);
      onSaved(s);
      setFeedback("Paramètres enregistrés.");
      setTimeout(() => setFeedback(null), 2500);
    } catch (e: any) {
      setFeedback("Erreur : " + e.message);
    } finally {
      setSaving(false);
    }
  }

  const pollStatus = async () => {
    try {
      const r = await get("/system/update/status");
      setUpdateState(r.state);
      setUpdateLog(r.log || "");
      if (r.state !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      // On successful update transition: trigger full-page reload after 5s so
      // the kiosk picks up the freshly-built frontend files automatically.
      if (r.state === "success" && prevStateRef.current === "running") {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          let n = 5;
          setReloadCountdown(n);
          const tick = setInterval(() => {
            n -= 1;
            setReloadCountdown(n);
            if (n <= 0) {
              clearInterval(tick);
              try { window.location.reload(); } catch {}
            }
          }, 1000);
        }
      }
      prevStateRef.current = r.state;
    } catch (e) { /* backend may be restarting */ }
  };

  useEffect(() => {
    pollStatus();
  }, []);

  useEffect(() => {
    if (updateState === "running" && !pollRef.current) {
      pollRef.current = setInterval(pollStatus, 2000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [updateState]);

  async function startUpdate(mode: "online" | "usb") {
    try {
      setUpdateLog("Démarrage de la mise à jour…");
      await post(mode === "online" ? "/system/update/online" : "/system/update/usb");
      setUpdateState("running");
      pollStatus();
    } catch (e: any) {
      setUpdateLog("Erreur : " + e.message);
      setUpdateState("failed");
    }
  }

  async function doExitKiosk() {
    try {
      await post("/system/exit-kiosk");
      setFeedback("Mode kiosque quitté.");
    } catch (e: any) {
      setFeedback("Erreur : " + e.message);
    }
  }

  return (
    <ScrollView
      style={s.wrap}
      contentContainerStyle={{ padding: SPACING.xl, paddingBottom: SPACING.xxl * 2 }}
      testID="settings-screen"
    >
      <Text style={s.title}>Paramètres et seuils</Text>
      <View style={s.card}>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Arrêt automatique pompe sur pression</Text>
            <Text style={s.sub}>Coupe la filtration si la pression sort de la plage définie.</Text>
          </View>
          <Switch
            testID="toggle-pressure-cutoff"
            value={!!state.pressure_auto_cutoff}
            onValueChange={(v) => setState({ ...state, pressure_auto_cutoff: v })}
            trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
          />
        </View>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Filtration auto selon température</Text>
            <Text style={s.sub}>Recommande le nombre d'heures = température / 2.</Text>
          </View>
          <Switch
            testID="toggle-auto-filtration"
            value={!!state.auto_filtration}
            onValueChange={(v) => setState({ ...state, auto_filtration: v })}
            trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
          />
        </View>
      </View>

      <Text style={s.section}>Seuils capteurs</Text>
      <View style={s.card}>
        {FIELDS.map((f) => (
          <View key={f.key} style={s.fieldRow}>
            <Text style={s.label}>{f.label}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING.sm }}>
              <TextInput
                testID={`input-${f.key}`}
                keyboardType="numeric"
                value={String(state[f.key] ?? "")}
                onChangeText={(t) => setState({ ...state, [f.key]: t })}
                style={s.input}
              />
              {f.unit && <Text style={s.sub}>{f.unit}</Text>}
            </View>
          </View>
        ))}
      </View>

      <Pressable
        testID="save-settings"
        onPress={save}
        style={[s.saveBtn, saving && { opacity: 0.6 }]}
        disabled={saving}
      >
        <Text style={s.saveText}>{saving ? "Enregistrement…" : "Enregistrer"}</Text>
      </Pressable>
      {feedback && <Text style={s.feedback}>{feedback}</Text>}

      {/* ---------------- Maintenance ---------------- */}
      <Text style={s.section}>Mises à jour et maintenance</Text>
      <View style={s.card}>
        <MaintenanceButton
          testID="update-online-btn"
          icon="cloud-download"
          color={COLORS.brand}
          title="Vérifier les mises à jour (Internet)"
          subtitle="Télécharge la dernière version depuis GitHub."
          confirming={confirmMode === "online"}
          disabled={updateState === "running"}
          onPress={() => {
            if (confirmMode === "online") { setConfirmMode(null); startUpdate("online"); }
            else setConfirmMode("online");
          }}
          onCancel={() => setConfirmMode(null)}
        />
        <MaintenanceButton
          testID="update-usb-btn"
          icon="save"
          color={COLORS.warning}
          title="Installer une mise à jour (clé USB)"
          subtitle="Cherche un fichier poolkiosk-update*.zip sur clé USB."
          confirming={confirmMode === "usb"}
          disabled={updateState === "running"}
          onPress={() => {
            if (confirmMode === "usb") { setConfirmMode(null); startUpdate("usb"); }
            else setConfirmMode("usb");
          }}
          onCancel={() => setConfirmMode(null)}
        />
        <MaintenanceButton
          testID="exit-kiosk-btn"
          icon="log-out"
          color={COLORS.error}
          title="Quitter le mode kiosque"
          subtitle="Ferme Chromium et revient au bureau du Raspberry."
          confirming={confirmMode === "exit"}
          disabled={updateState === "running"}
          last
          onPress={() => {
            if (confirmMode === "exit") { setConfirmMode(null); doExitKiosk(); }
            else setConfirmMode("exit");
          }}
          onCancel={() => setConfirmMode(null)}
        />
      </View>

      {(updateState === "running" || !!updateLog) && (
        <View style={[s.card, { marginTop: SPACING.md }]}>
          <View style={s.updateHead}>
            <View
              style={[
                s.updateDot,
                {
                  backgroundColor:
                    updateState === "running" ? COLORS.warning :
                    updateState === "success" ? COLORS.success :
                    updateState === "failed" ? COLORS.error : COLORS.textMuted,
                },
              ]}
            />
            <Text style={s.updateStateText}>
              {updateState === "running" && "Mise à jour en cours…"}
              {updateState === "success" && (
                reloadCountdown !== null
                  ? `Mise à jour terminée. Rechargement dans ${reloadCountdown}s…`
                  : "Mise à jour terminée avec succès"
              )}
              {updateState === "failed" && "Échec de la mise à jour"}
              {updateState === "idle" && "En attente"}
            </Text>
            {updateState !== "running" && (
              <Pressable
                onPress={() => { setUpdateLog(""); setUpdateState("idle"); }}
                style={s.dismissBtn}
                testID="update-dismiss"
              >
                <Ionicons name="close" size={16} color={COLORS.textSecondary} />
                <Text style={s.dismissText}>Fermer</Text>
              </Pressable>
            )}
          </View>
          <ScrollView
            ref={logScroll}
            style={s.logBox}
            onContentSizeChange={() => logScroll.current?.scrollToEnd({ animated: false })}
          >
            <Text style={s.logText}>{updateLog || "…"}</Text>
          </ScrollView>
        </View>
      )}
    </ScrollView>
  );
};

// ----------- Sub-component -----------
const MaintenanceButton: React.FC<{
  testID: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: string;
  subtitle: string;
  confirming: boolean;
  disabled: boolean;
  last?: boolean;
  onPress: () => void;
  onCancel: () => void;
}> = ({ testID, icon, color, title, subtitle, confirming, disabled, last, onPress, onCancel }) => (
  <View style={[s.maintRow, last && { borderBottomWidth: 0 }]}>
    <View style={[s.iconBubble, { backgroundColor: color + "22", borderColor: color }]}>
      <Ionicons name={icon} size={22} color={color} />
    </View>
    <View style={{ flex: 1, marginLeft: SPACING.md }}>
      <Text style={s.label}>{title}</Text>
      <Text style={s.sub}>{subtitle}</Text>
    </View>
    {confirming ? (
      <View style={{ flexDirection: "row", gap: SPACING.sm }}>
        <Pressable
          testID={`${testID}-cancel`}
          onPress={onCancel}
          style={[s.actionBtn, { backgroundColor: COLORS.surfaceTertiary }]}
        >
          <Text style={{ color: COLORS.textSecondary, fontWeight: "600" }}>Annuler</Text>
        </Pressable>
        <Pressable
          testID={`${testID}-confirm`}
          onPress={onPress}
          style={[s.actionBtn, { backgroundColor: color }]}
        >
          <Text style={{ color: "#fff", fontWeight: "700" }}>Confirmer</Text>
        </Pressable>
      </View>
    ) : (
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        style={[s.actionBtn, { borderWidth: 1, borderColor: color, opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={{ color, fontWeight: "600" }}>Lancer</Text>
      </Pressable>
    )}
  </View>
);

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.lg },
  section: { color: COLORS.textSecondary, fontSize: FS.lg, marginTop: SPACING.xl, marginBottom: SPACING.md, fontWeight: "600" },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  fieldRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  label: { color: COLORS.text, fontSize: FS.base, fontWeight: "500" },
  sub: { color: COLORS.textMuted, fontSize: FS.sm },
  input: {
    backgroundColor: COLORS.surfaceTertiary, color: COLORS.text, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, width: 110, textAlign: "right",
    borderWidth: 1, borderColor: COLORS.border,
  },
  saveBtn: {
    marginTop: SPACING.xl, backgroundColor: COLORS.brand, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, alignItems: "center",
  },
  saveText: { color: "#fff", fontSize: FS.lg, fontWeight: "600" },
  feedback: { color: COLORS.success, textAlign: "center", marginTop: SPACING.md },
  maintRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  iconBubble: {
    width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center",
    borderWidth: 1,
  },
  actionBtn: {
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm, borderRadius: RADIUS.md,
  },
  updateHead: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, marginBottom: SPACING.sm },
  updateDot: { width: 10, height: 10, borderRadius: 5 },
  updateStateText: { color: COLORS.text, fontWeight: "600" },
  dismissBtn: {
    marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: SPACING.md, paddingVertical: 6,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceTertiary,
  },
  dismissText: { color: COLORS.textSecondary, fontSize: FS.sm, fontWeight: "600" },
  logBox: {
    maxHeight: 200, backgroundColor: "#000", borderRadius: RADIUS.md,
    padding: SPACING.sm, borderWidth: 1, borderColor: COLORS.border,
  },
  logText: { color: "#9BE894", fontFamily: "monospace" as any, fontSize: 11, lineHeight: 15 },
});
