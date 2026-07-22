import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Task = {
  id: string;
  name: string;
  icon: string;
  interval_days: number;
  last_done_at: string | null;
  enabled: boolean;
  days_remaining: number;
  is_overdue: boolean;
};

const ICON_CHOICES: { key: string; label: string }[] = [
  { key: "sparkles-outline", label: "Nettoyage" },
  { key: "sync", label: "Contre-lavage" },
  { key: "flask", label: "Chimie" },
  { key: "water", label: "Eau" },
  { key: "construct", label: "Générique" },
  { key: "hammer", label: "Réparation" },
];

function confirm(title: string, message: string, onOk: () => void) {
  if (Platform.OS === "web") {
    // eslint-disable-next-line no-restricted-globals
    if (typeof window !== "undefined" && window.confirm && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: "Annuler", style: "cancel" },
    { text: "Confirmer", style: "destructive", onPress: onOk },
  ]);
}

export const MaintenanceScreen: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [interval, setInterval] = useState("30");
  const [icon, setIcon] = useState("construct");

  const load = useCallback(async () => {
    try {
      const r = await api.maintenance();
      setTasks(r.tasks || []);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  function openAdd() {
    setEditing(null);
    setName("");
    setInterval("30");
    setIcon("construct");
    setShowAdd(true);
  }

  function openEdit(t: Task) {
    setEditing(t);
    setName(t.name);
    setInterval(String(t.interval_days));
    setIcon(t.icon || "construct");
    setShowAdd(true);
  }

  async function save() {
    const n = name.trim();
    const iv = parseInt(interval, 10);
    if (!n || !Number.isFinite(iv) || iv <= 0) return;
    if (editing) {
      await api.updateMaintenance(editing.id, { name: n, interval_days: iv, icon });
    } else {
      await api.createMaintenance({ name: n, interval_days: iv, icon });
    }
    setShowAdd(false);
    load();
  }

  async function del(t: Task) {
    confirm(
      "Supprimer la tâche",
      `Supprimer définitivement « ${t.name} » ?`,
      async () => {
        await api.deleteMaintenance(t.id);
        load();
      },
    );
  }

  async function markDone(t: Task) {
    await api.markMaintenanceDone(t.id);
    load();
  }

  async function toggle(t: Task) {
    await api.updateMaintenance(t.id, { enabled: !t.enabled });
    load();
  }

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="maintenance-screen">
      <View style={s.header}>
        <Text style={s.title}>Rappels de maintenance</Text>
        <Pressable onPress={openAdd} style={s.addBtn} testID="maintenance-add">
          <Ionicons name="add" size={22} color="#fff" />
          <Text style={s.addBtnText}>Nouvelle tâche</Text>
        </Pressable>
      </View>
      <Text style={s.subtitle}>
        Configurez l'intervalle en jours entre chaque tâche récurrente. L'app vous alerte quand la date est
        atteinte. Marquez « Fait » pour réinitialiser le compteur.
      </Text>

      {showAdd && (
        <View style={s.form}>
          <Text style={s.formTitle}>{editing ? "Modifier la tâche" : "Nouvelle tâche"}</Text>
          <Text style={s.label}>Nom</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Ex : Vérification pH"
            placeholderTextColor={COLORS.textMuted}
            style={s.input}
            testID="maint-input-name"
          />
          <Text style={s.label}>Intervalle (jours)</Text>
          <TextInput
            value={interval}
            onChangeText={setInterval}
            keyboardType="numeric"
            placeholder="30"
            placeholderTextColor={COLORS.textMuted}
            style={s.input}
            testID="maint-input-interval"
          />
          <Text style={s.label}>Icône</Text>
          <View style={s.iconPicker}>
            {ICON_CHOICES.map((ic) => (
              <Pressable
                key={ic.key}
                onPress={() => setIcon(ic.key)}
                style={[
                  s.iconChoice,
                  icon === ic.key && { borderColor: COLORS.brand, backgroundColor: COLORS.surfaceTertiary },
                ]}
                testID={`maint-icon-${ic.key}`}
              >
                <Ionicons name={ic.key as any} size={20} color={icon === ic.key ? COLORS.brand : COLORS.textSecondary} />
                <Text style={[s.iconChoiceLabel, icon === ic.key && { color: COLORS.text }]}>{ic.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.formActions}>
            <Pressable onPress={() => setShowAdd(false)} style={[s.cancelBtn]} testID="maint-cancel">
              <Text style={s.cancelBtnText}>Annuler</Text>
            </Pressable>
            <Pressable onPress={save} style={s.saveBtn} testID="maint-save">
              <Ionicons name="checkmark" size={20} color="#fff" />
              <Text style={s.saveBtnText}>Enregistrer</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={s.list}>
        {tasks.length === 0 ? (
          <Text style={{ color: COLORS.textMuted, padding: SPACING.md }}>Aucune tâche configurée.</Text>
        ) : (
          tasks.map((t) => {
            const late = t.is_overdue && t.enabled;
            const daysAbs = Math.abs(t.days_remaining);
            const status = !t.enabled
              ? "Désactivée"
              : late
                ? daysAbs < 1 ? "À faire maintenant" : `En retard de ${daysAbs.toFixed(0)} j`
                : daysAbs < 1 ? "Bientôt (< 24h)" : `Dans ${daysAbs.toFixed(0)} j`;
            const lastLabel = t.last_done_at
              ? new Date(t.last_done_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })
              : "Jamais faite";
            return (
              <View key={t.id} style={s.row} testID={`maint-row-${t.id}`}>
                <Ionicons
                  name={(t.icon as any) || "construct"}
                  size={26}
                  color={late ? COLORS.error : COLORS.textSecondary}
                />
                <View style={{ flex: 1, marginLeft: SPACING.md }}>
                  <Text style={s.rowName}>{t.name}</Text>
                  <Text style={[s.rowMeta, late && { color: COLORS.error, fontWeight: "600" }]}>
                    {status}   ·   tous les {t.interval_days} j
                  </Text>
                  <Text style={s.rowLast}>Dernière fois : {lastLabel}</Text>
                </View>
                <View style={s.rowActions}>
                  <Pressable
                    onPress={() => markDone(t)}
                    style={[s.doneBtn, late && { backgroundColor: COLORS.success }]}
                    testID={`maint-done-${t.id}`}
                  >
                    <Ionicons name="checkmark" size={18} color={late ? "#fff" : COLORS.success} />
                    <Text style={[s.doneText, late && { color: "#fff" }]}>Fait</Text>
                  </Pressable>
                  <Pressable onPress={() => openEdit(t)} style={s.iconBtn} testID={`maint-edit-${t.id}`}>
                    <Ionicons name="pencil" size={18} color={COLORS.textSecondary} />
                  </Pressable>
                  <Pressable onPress={() => toggle(t)} style={s.iconBtn} testID={`maint-toggle-${t.id}`}>
                    <Ionicons
                      name={t.enabled ? "eye" : "eye-off"}
                      size={18}
                      color={t.enabled ? COLORS.brand : COLORS.textMuted}
                    />
                  </Pressable>
                  <Pressable onPress={() => del(t)} style={s.iconBtn} testID={`maint-del-${t.id}`}>
                    <Ionicons name="trash" size={18} color={COLORS.error} />
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SPACING.sm },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700" },
  subtitle: { color: COLORS.textMuted, fontSize: FS.sm, marginBottom: SPACING.lg },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    backgroundColor: COLORS.brand, borderRadius: RADIUS.md,
  },
  addBtnText: { color: "#fff", fontSize: FS.base, fontWeight: "700" },
  form: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.border,
    marginBottom: SPACING.lg,
  },
  formTitle: { color: COLORS.text, fontSize: FS.lg, fontWeight: "700", marginBottom: SPACING.md },
  label: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: SPACING.sm },
  input: {
    backgroundColor: COLORS.surfaceTertiary, color: COLORS.text,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    marginTop: 4, borderWidth: 1, borderColor: COLORS.border,
  },
  iconPicker: {
    flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginTop: SPACING.xs,
  },
  iconChoice: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.pill,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceSecondary,
  },
  iconChoiceLabel: { color: COLORS.textMuted, fontSize: FS.sm, fontWeight: "500" },
  formActions: { flexDirection: "row", justifyContent: "flex-end", gap: SPACING.sm, marginTop: SPACING.lg },
  cancelBtn: {
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceTertiary,
  },
  cancelBtnText: { color: COLORS.textSecondary, fontSize: FS.base, fontWeight: "600" },
  saveBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, backgroundColor: COLORS.success,
  },
  saveBtnText: { color: "#fff", fontSize: FS.base, fontWeight: "700" },
  list: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  rowName: { color: COLORS.text, fontSize: FS.lg, fontWeight: "600" },
  rowMeta: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  rowLast: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2, fontStyle: "italic" },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  doneBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.success, backgroundColor: COLORS.surfaceTertiary,
  },
  doneText: { color: COLORS.success, fontSize: FS.sm, fontWeight: "700" },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    backgroundColor: COLORS.surfaceTertiary, borderWidth: 1, borderColor: COLORS.border,
  },
});
