import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Switch } from "react-native";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Props = { settings: any; onSaved: (s: any) => void };

const FIELDS: { key: string; label: string; unit?: string; step?: number }[] = [
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

export const SettingsScreen: React.FC<Props> = ({ settings, onSaved }) => {
  const [state, setState] = useState<any>(settings || {});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

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

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="settings-screen">
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
    </ScrollView>
  );
};

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
});
