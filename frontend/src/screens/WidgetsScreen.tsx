import React, { useState } from "react";
import { View, Text, StyleSheet, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Widget = { id: string; name: string; enabled: boolean; order: number };
type Props = { widgets: Widget[]; onChange: (w: Widget[]) => void };

export const WidgetsScreen: React.FC<Props> = ({ widgets, onChange }) => {
  const [items, setItems] = useState<Widget[]>([...widgets].sort((a, b) => a.order - b.order));

  React.useEffect(() => {
    setItems([...widgets].sort((a, b) => a.order - b.order));
  }, [widgets]);

  async function persist(next: Widget[]) {
    const withOrder = next.map((w, i) => ({ ...w, order: i + 1 }));
    setItems(withOrder);
    onChange(withOrder);
    await api.updateWidgets(withOrder);
  }

  async function toggle(w: Widget) {
    const next = items.map((it) => (it.id === w.id ? { ...it, enabled: !it.enabled } : it));
    await persist(next);
  }

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Widget>) => (
    <ScaleDecorator>
      <View
        testID={`widget-row-${item.id}`}
        style={[s.row, isActive && { backgroundColor: COLORS.surfaceTertiary, borderColor: COLORS.brand }]}
      >
        <View
          onStartShouldSetResponder={() => true}
          onResponderGrant={drag}
          onTouchStart={drag}
          style={s.handle}
          testID={`widget-drag-${item.id}`}
        >
          <Ionicons name="reorder-three" size={24} color={COLORS.textMuted} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.name}>{item.name}</Text>
          <Text style={s.sub}>{item.enabled ? "Affiché" : "Masqué"}</Text>
        </View>
        <Switch
          testID={`widget-toggle-${item.id}`}
          value={item.enabled}
          onValueChange={() => toggle(item)}
          trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
        />
      </View>
    </ScaleDecorator>
  );

  return (
    <View style={s.wrap} testID="widgets-screen">
      <View style={{ padding: SPACING.xl, paddingBottom: SPACING.md }}>
        <Text style={s.title}>Gestion des widgets</Text>
        <Text style={s.sub}>
          Glissez pour réordonner. Activez ou désactivez chaque tuile du tableau de bord.
        </Text>
      </View>
      <View style={{ paddingHorizontal: SPACING.xl, flex: 1 }}>
        <View style={s.card}>
          <DraggableFlatList
            data={items}
            keyExtractor={(it) => it.id}
            onDragEnd={({ data }) => persist(data)}
            renderItem={renderItem}
            activationDistance={5}
          />
        </View>
      </View>
    </View>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.xs },
  sub: { color: COLORS.textMuted, fontSize: FS.sm },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border, flex: 1,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.border,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: "transparent",
  },
  handle: { padding: SPACING.sm, marginRight: SPACING.sm, cursor: "grab" as any },
  name: { color: COLORS.text, fontSize: FS.lg, fontWeight: "600" },
});
