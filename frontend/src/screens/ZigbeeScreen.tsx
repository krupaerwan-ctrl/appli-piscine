import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

type Device = {
  id: string;
  friendly_name: string;
  model: string;
  device_type: string;
  assigned_role: string;
  online: boolean;
  last_seen: string;
};

const RELAY_ROLES: { key: string; label: string }[] = [
  { key: "none", label: "Non assigné" },
  { key: "filtration", label: "Pompe filtration" },
  { key: "electrolyseur", label: "Électrolyseur" },
  { key: "heat_pump", label: "Pompe à chaleur" },
  { key: "lighting", label: "Éclairage" },
];

const SENSOR_ROLES: { key: string; label: string }[] = [
  { key: "none", label: "Non assigné" },
  { key: "temp", label: "Température eau" },
  { key: "ph", label: "pH" },
  { key: "orp", label: "Redox (ORP)" },
  { key: "salinity", label: "Salinité" },
  { key: "pressure", label: "Pression" },
];

export const ZigbeeScreen: React.FC = () => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string>("");
  const [rescanning, setRescanning] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`${BASE}/api/zigbee/devices`);
    const d = await r.json();
    setDevices(d.devices || []);
  }
  useEffect(() => { load(); }, []);

  async function setRole(id: string, role: string) {
    await fetch(`${BASE}/api/zigbee/devices/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_role: role }),
    });
    load();
    setFeedback("Assignation mise à jour.");
    setTimeout(() => setFeedback(null), 2000);
  }

  async function saveName(id: string) {
    await fetch(`${BASE}/api/zigbee/devices/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendly_name: nameDraft }),
    });
    setEditing(null); setNameDraft("");
    load();
  }

  async function rescan() {
    setRescanning(true);
    try {
      await fetch(`${BASE}/api/zigbee/devices/rescan`, { method: "POST" });
      await load();
      setFeedback("Recherche terminée.");
      setTimeout(() => setFeedback(null), 2000);
    } finally { setRescanning(false); }
  }

  const relays = devices.filter((d) => d.device_type === "relay");
  const sensors = devices.filter((d) => d.device_type === "sensor");
  const other = devices.filter((d) => d.device_type !== "relay" && d.device_type !== "sensor");

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
            <Pressable
              onPress={() => { setEditing(d.id); setNameDraft(d.friendly_name || ""); }}
              testID={`zigbee-edit-name-${d.id}`}
            >
              <Text style={s.deviceName}>
                {d.friendly_name || d.id}
                <Text style={{ color: COLORS.textMuted, fontSize: FS.sm }}>   ✎</Text>
              </Text>
              <Text style={s.deviceSub}>{d.model} · {d.id}</Text>
            </Pressable>
          )}
        </View>
      </View>
      <View style={s.roleRow}>
        <Text style={s.roleLabel}>Rôle :</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACING.xs }}>
          {roleList.map((r) => {
            const active = d.assigned_role === r.key || (r.key === "none" && !d.assigned_role);
            return (
              <Pressable
                key={r.key}
                onPress={() => setRole(d.id, r.key)}
                style={[s.chip, active && s.chipActive]}
                testID={`zigbee-role-${d.id}-${r.key}`}
              >
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
        <View>
          <Text style={s.title}>Appareils Zigbee</Text>
          <Text style={s.sub}>Gérez vos relais et sondes détectés sur le réseau Zigbee.</Text>
        </View>
        <Pressable onPress={rescan} disabled={rescanning} style={[s.rescanBtn, rescanning && { opacity: 0.5 }]}
          testID="zigbee-rescan">
          <Ionicons name="refresh" size={18} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "600" }}>{rescanning ? "Recherche…" : "Rescanner"}</Text>
        </Pressable>
      </View>
      {feedback && <Text style={s.feedback}>{feedback}</Text>}

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
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700" },
  sub: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  section: { color: COLORS.textSecondary, fontSize: FS.lg, fontWeight: "600", marginTop: SPACING.xl, marginBottom: SPACING.sm },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border, marginBottom: SPACING.sm,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  deviceName: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  deviceSub: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
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
  rescanBtn: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    backgroundColor: COLORS.brand, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
  },
  empty: { color: COLORS.textMuted, fontSize: FS.sm, fontStyle: "italic" },
  feedback: { color: COLORS.success, marginTop: SPACING.sm },
});
