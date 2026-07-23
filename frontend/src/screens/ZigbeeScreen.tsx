import React, { useEffect, useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Device = {
  id: string;
  friendly_name: string;
  model: string;
  device_type: string;
  assigned_role: string;
  online: boolean;
  last_seen: string;
  battery?: number | null;
  lqi?: number | null;
};

type Status = {
  broker_connected: boolean;
  broker_host: string | null;
  broker_port: number | null;
  permit_join: boolean;
  permit_join_until: string | null;
  last_bridge_state: string | null;
  device_count: number;
  online_count: number;
  mqtt_source?: string;
};

const RELAY_ROLES = [
  { key: "none", label: "Non assigné" },
  { key: "filtration", label: "Pompe filtration" },
  { key: "electrolyseur", label: "Électrolyseur" },
  { key: "heat_pump", label: "Pompe à chaleur" },
  { key: "lighting", label: "Éclairage" },
];
const SENSOR_ROLES = [
  { key: "none", label: "Non assigné" },
  { key: "temp", label: "Température" },
  { key: "ph", label: "pH" },
  { key: "orp", label: "Redox (ORP)" },
  { key: "salinity", label: "Salinité" },
  { key: "pressure", label: "Pression" },
];

function confirm(title: string, message: string, onOk: () => void) {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: "Annuler", style: "cancel" },
    { text: "Supprimer", style: "destructive", onPress: onOk },
  ]);
}

function formatLastSeen(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const min = Math.round(diffMs / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `il y a ${h} h`;
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  } catch { return "—"; }
}

export const ZigbeeScreen: React.FC = () => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string>("");
  const [feedback, setFeedback] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const countdownRef = useRef<any>(null);

  const flash = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setFeedback({ msg, kind });
    setTimeout(() => setFeedback(null), 2500);
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.zigbee.list(), api.zigbee.status()]);
      setDevices(d.devices || []);
      setStatus(s);
      // Sync countdown from server
      if (s?.permit_join_until) {
        const remain = Math.max(0, Math.round(
          (new Date(s.permit_join_until).getTime() - Date.now()) / 1000,
        ));
        setCountdown(remain);
      } else {
        setCountdown(0);
      }
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Poll every 3s while on screen — devices arrive live during pairing
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Local ticking countdown
  useEffect(() => {
    if (countdown <= 0) {
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }
    countdownRef.current = setInterval(() => {
      setCountdown((c) => (c > 1 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [countdown]);

  async function startPairing() {
    try {
      const r = await api.zigbee.permitJoin(60);
      setCountdown(r.duration || 60);
      flash(r.simulated
        ? "Pairing démarré (mode simulateur — configurez MQTT_BROKER pour du vrai Zigbee)"
        : "Pairing ouvert pendant 60s. Mettez votre sonde en mode appairage.",
      );
      load();
    } catch (e: any) {
      flash("Impossible de démarrer le pairing : " + (e?.message || ""), "err");
    }
  }
  async function stopPairing() {
    try {
      await api.zigbee.permitJoinStop();
      setCountdown(0);
      flash("Pairing arrêté.");
      load();
    } catch {}
  }
  async function testBroker() {
    try {
      const r = await api.zigbee.brokerTest();
      flash(r.hint || (r.connected ? "Broker OK" : "Broker HS"), r.connected ? "ok" : "err");
      load();
    } catch (e: any) {
      flash("Test échoué : " + (e?.message || ""), "err");
    }
  }
  async function setRole(id: string, role: string) {
    await api.zigbee.update(id, { assigned_role: role });
    flash("Rôle mis à jour.");
    load();
  }
  async function saveName(id: string) {
    if (!nameDraft.trim()) { setEditing(null); return; }
    await api.zigbee.update(id, { friendly_name: nameDraft.trim() });
    setEditing(null); setNameDraft("");
    flash("Nom mis à jour.");
    load();
  }
  async function removeDevice(d: Device) {
    confirm(
      "Supprimer l'appareil",
      `Retirer « ${d.friendly_name || d.id} » du réseau Zigbee ?`,
      async () => {
        try {
          await api.zigbee.remove(d.id);
          flash("Appareil retiré.");
          load();
        } catch (e: any) {
          flash("Suppression échouée : " + (e?.message || ""), "err");
        }
      },
    );
  }

  const relays = devices.filter((d) => d.device_type === "relay");
  const sensors = devices.filter((d) => d.device_type === "sensor");
  const other = devices.filter((d) => d.device_type !== "relay" && d.device_type !== "sensor");
  const brokerOk = !!status?.broker_connected;
  const isPairing = countdown > 0;

  const renderDevice = (d: Device, roleList: { key: string; label: string }[]) => (
    <View style={s.card} key={d.id} testID={`zigbee-${d.id}`}>
      <View style={s.headRow}>
        <View style={[s.dot, { backgroundColor: d.online ? COLORS.success : COLORS.textMuted }]} />
        <View style={{ flex: 1 }}>
          {editing === d.id ? (
            <View style={{ flexDirection: "row", gap: SPACING.sm, alignItems: "center" }}>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                style={s.nameInput}
                autoFocus
                testID={`zigbee-name-input-${d.id}`}
              />
              <Pressable onPress={() => saveName(d.id)} style={s.saveBtn} testID={`zigbee-name-save-${d.id}`}>
                <Ionicons name="checkmark" size={16} color="#fff" />
              </Pressable>
              <Pressable onPress={() => { setEditing(null); setNameDraft(""); }} style={s.cancelBtn}>
                <Ionicons name="close" size={16} color={COLORS.textSecondary} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => { setEditing(d.id); setNameDraft(d.friendly_name || ""); }}
              testID={`zigbee-edit-name-${d.id}`}>
              <Text style={s.deviceName}>
                {d.friendly_name || d.id}<Text style={{ color: COLORS.textMuted, fontSize: FS.sm }}>   ✎</Text>
              </Text>
              <Text style={s.deviceSub}>{d.model} · {d.id}</Text>
            </Pressable>
          )}
          <View style={s.metaRow}>
            <View style={s.metaItem}>
              <Ionicons name="time" size={12} color={COLORS.textMuted} />
              <Text style={s.metaText}>Vu {formatLastSeen(d.last_seen)}</Text>
            </View>
            {d.battery != null && (
              <View style={s.metaItem}>
                <Ionicons name={d.battery < 20 ? "battery-dead" : "battery-half"} size={12}
                  color={d.battery < 20 ? COLORS.error : COLORS.textMuted} />
                <Text style={[s.metaText, d.battery < 20 && { color: COLORS.error }]}>
                  {d.battery}%
                </Text>
              </View>
            )}
            {d.lqi != null && (
              <View style={s.metaItem}>
                <Ionicons name="wifi" size={12} color={COLORS.textMuted} />
                <Text style={s.metaText}>LQI {d.lqi}</Text>
              </View>
            )}
          </View>
        </View>
        <Pressable onPress={() => removeDevice(d)} style={s.trashBtn} testID={`zigbee-remove-${d.id}`}>
          <Ionicons name="trash" size={16} color={COLORS.error} />
        </Pressable>
      </View>
      <View style={s.roleRow}>
        <Text style={s.roleLabel}>Rôle :</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACING.xs }}>
          {roleList.map((r) => {
            const active = d.assigned_role === r.key || (r.key === "none" && !d.assigned_role);
            return (
              <Pressable key={r.key} onPress={() => setRole(d.id, r.key)}
                style={[s.chip, active && s.chipActive]}
                testID={`zigbee-role-${d.id}-${r.key}`}>
                <Text style={[s.chipText, active && s.chipTextActive]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl, paddingBottom: SPACING.xxl * 2 }}
      testID="zigbee-screen">
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Appareils Zigbee</Text>
          <Text style={s.sub}>
            {status?.mqtt_source === "broker"
              ? `Broker MQTT ${status.broker_host}:${status.broker_port}${brokerOk ? " ✓" : " ✗"}`
              : "Mode simulateur — configurez MQTT_BROKER dans .env pour du vrai Zigbee."}
          </Text>
        </View>
        <Pressable onPress={testBroker} style={s.iconBtn} testID="zigbee-broker-test">
          <Ionicons name="pulse" size={16} color={COLORS.textSecondary} />
          <Text style={s.iconBtnText}>Tester broker</Text>
        </Pressable>
      </View>

      {/* Big pairing button / countdown */}
      <View style={s.pairingCard}>
        <View style={{ flex: 1 }}>
          <Text style={s.pairingTitle}>
            {isPairing ? "🔍 Recherche en cours…" : "Ajouter une nouvelle sonde"}
          </Text>
          <Text style={s.pairingHint}>
            {isPairing
              ? `Mettez votre sonde/relais en mode appairage. Ils apparaîtront ci-dessous automatiquement.`
              : "Ouvrez la fenêtre de pairing 60s puis mettez votre appareil en mode découverte."}
          </Text>
        </View>
        {isPairing ? (
          <View style={s.pairingActions}>
            <View style={s.countdownBadge}>
              <Text style={s.countdownText}>{countdown}s</Text>
            </View>
            <Pressable onPress={stopPairing} style={s.pairingStopBtn} testID="zigbee-permit-stop">
              <Ionicons name="stop" size={20} color="#fff" />
              <Text style={s.pairingBtnText}>Arrêter</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={startPairing} style={s.pairingBtn} testID="zigbee-permit-join">
            <Ionicons name="search" size={22} color="#fff" />
            <Text style={s.pairingBtnText}>Rechercher une sonde</Text>
          </Pressable>
        )}
      </View>

      {feedback && (
        <View style={[s.toast, feedback.kind === "err" ? { backgroundColor: COLORS.error } : { backgroundColor: COLORS.success }]}>
          <Text style={s.toastText}>{feedback.msg}</Text>
        </View>
      )}

      <Text style={s.section}>Relais ({relays.length})</Text>
      {relays.length === 0 ? (
        <Text style={s.empty}>Aucun relais détecté.</Text>
      ) : relays.map((d) => renderDevice(d, RELAY_ROLES))}

      <Text style={s.section}>Sondes ({sensors.length})</Text>
      {sensors.length === 0 ? (
        <Text style={s.empty}>Aucune sonde détectée.</Text>
      ) : sensors.map((d) => renderDevice(d, SENSOR_ROLES))}

      {other.length > 0 && (
        <>
          <Text style={s.section}>Autres ({other.length})</Text>
          {other.map((d) => renderDevice(d, [...RELAY_ROLES, ...SENSOR_ROLES.slice(1)]))}
        </>
      )}
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: SPACING.md },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700" },
  sub: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  section: { color: COLORS.textSecondary, fontSize: FS.lg, fontWeight: "600", marginTop: SPACING.xl, marginBottom: SPACING.sm },
  iconBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.surfaceTertiary, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border,
  },
  iconBtnText: { color: COLORS.textSecondary, fontSize: FS.sm, fontWeight: "600" },
  pairingCard: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.brand,
    marginTop: SPACING.lg, flexDirection: "row", gap: SPACING.md, alignItems: "center",
    flexWrap: "wrap",
  },
  pairingTitle: { color: COLORS.text, fontSize: FS.lg, fontWeight: "700" },
  pairingHint: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 4 },
  pairingBtn: {
    flexDirection: "row", alignItems: "center", gap: SPACING.sm,
    paddingHorizontal: SPACING.xl, paddingVertical: SPACING.md,
    backgroundColor: COLORS.brand, borderRadius: RADIUS.md, minHeight: 48,
  },
  pairingStopBtn: {
    flexDirection: "row", alignItems: "center", gap: SPACING.sm,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    backgroundColor: COLORS.error, borderRadius: RADIUS.md, minHeight: 48,
  },
  pairingBtnText: { color: "#fff", fontSize: FS.base, fontWeight: "700" },
  pairingActions: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  countdownBadge: {
    backgroundColor: COLORS.brand, borderRadius: 999,
    paddingHorizontal: 16, paddingVertical: 12, minWidth: 60, alignItems: "center",
  },
  countdownText: { color: "#fff", fontSize: FS.lg, fontWeight: "700", fontVariant: ["tabular-nums"] },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: SPACING.sm,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  deviceName: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  deviceSub: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  metaRow: { flexDirection: "row", gap: SPACING.md, marginTop: 4 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: COLORS.textMuted, fontSize: 11 },
  trashBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    backgroundColor: COLORS.surfaceTertiary, borderWidth: 1, borderColor: COLORS.border,
  },
  nameInput: {
    backgroundColor: COLORS.surfaceTertiary, color: COLORS.text, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, flex: 1,
    borderWidth: 1, borderColor: COLORS.border, fontSize: FS.base,
  },
  saveBtn: { backgroundColor: COLORS.success, padding: SPACING.sm, borderRadius: RADIUS.md },
  cancelBtn: { backgroundColor: COLORS.surfaceTertiary, padding: SPACING.sm, borderRadius: RADIUS.md },
  roleRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, marginTop: SPACING.sm },
  roleLabel: { color: COLORS.textMuted, fontSize: FS.sm, flexShrink: 0 },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surfaceTertiary, borderWidth: 1, borderColor: COLORS.border,
    flexShrink: 0,
  },
  chipActive: { borderColor: COLORS.brand, backgroundColor: COLORS.brand + "22" },
  chipText: { color: COLORS.textMuted, fontSize: FS.sm },
  chipTextActive: { color: COLORS.brand, fontWeight: "600" },
  empty: { color: COLORS.textMuted, fontSize: FS.sm, fontStyle: "italic" },
  toast: {
    marginTop: SPACING.md, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
  },
  toastText: { color: "#fff", fontSize: FS.sm, fontWeight: "600" },
});
