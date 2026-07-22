import React from "react";
import { View, Text, StyleSheet, Pressable, Switch, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LineChart } from "react-native-gifted-charts";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";

// -------- Card wrapper --------
export const Card: React.FC<{ children: React.ReactNode; style?: any; testID?: string }> = ({
  children, style, testID,
}) => (
  <View testID={testID} style={[styles.card, style]}>{children}</View>
);

// -------- Metric card (Temp/pH/ORP/Salinity) --------
type MetricProps = {
  label: string;
  value: number | string;
  unit: string;
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
  target?: string;
  min?: number;
  max?: number;
  current?: number;
  testID?: string;
};
export const MetricCard: React.FC<MetricProps> = ({
  label, value, unit, color, icon, target, min, max, current, testID,
}) => {
  const pct =
    typeof current === "number" && typeof min === "number" && typeof max === "number"
      ? Math.max(0, Math.min(1, (current - min) / (max - min)))
      : null;
  return (
    <Card testID={testID} style={{ flex: 1, minWidth: 180 }}>
      <View style={styles.metricHead}>
        <Ionicons name={icon} size={18} color={color} />
        <Text style={styles.metricLabel}>{label}</Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={[styles.metricValue, { color }]}>{value}</Text>
        <Text style={styles.metricUnit}>{unit}</Text>
      </View>
      {target && <Text style={styles.metricTarget}>{target}</Text>}
      {pct !== null && (
        <View style={styles.gaugeWrap}>
          <View style={styles.gaugeTrack}>
            <View style={[styles.gaugeFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
            <View style={[styles.gaugeThumb, { left: `${pct * 100}%`, backgroundColor: color }]} />
          </View>
          <View style={styles.gaugeLabels}>
            <Text style={styles.metricTarget}>{min}</Text>
            <Text style={styles.metricTarget}>{max}</Text>
          </View>
        </View>
      )}
    </Card>
  );
};

// -------- Pump manual control + runtime counter --------
type PumpProps = {
  state: boolean;
  todayHours: number;
  weekHours: number;
  manualOverride: boolean;
  autoFiltration: boolean;
  waterTemp: number;
  recommendedHours: number;
  onToggle: (next: boolean) => void;
  onClearOverride: () => void;
};
export const PumpControlCard: React.FC<PumpProps> = ({
  state, todayHours, weekHours, manualOverride, autoFiltration, waterTemp,
  recommendedHours, onToggle, onClearOverride,
}) => {
  const showOverrideBadge = manualOverride && autoFiltration;
  return (
    <Card testID="widget-pump" style={{ flex: 2, minWidth: 380 }}>
      <View style={styles.metricHead}>
        <Ionicons name="power" size={18} color={COLORS.brand} />
        <Text style={styles.metricLabel}>Contrôle pompe</Text>
        {showOverrideBadge && (
          <View style={pumpS.badge} testID="pump-override-badge">
            <Ionicons name="lock-closed" size={12} color={COLORS.warning} />
            <Text style={pumpS.badgeText}>Mode manuel</Text>
          </View>
        )}
      </View>

      <View style={pumpS.mainRow}>
        <Pressable
          onPress={() => onToggle(!state)}
          testID="pump-main-toggle"
          style={[
            pumpS.mainBtn,
            { backgroundColor: state ? COLORS.success : COLORS.surfaceTertiary,
              borderColor: state ? COLORS.success : COLORS.borderStrong },
          ]}
        >
          <Ionicons
            name={state ? "stop-circle" : "play-circle"}
            size={54}
            color={state ? "#fff" : COLORS.brand}
          />
          <Text style={[pumpS.mainBtnText, { color: state ? "#fff" : COLORS.text }]}>
            {state ? "Arrêter" : "Démarrer"}
          </Text>
          <Text style={[pumpS.mainBtnHint, { color: state ? "rgba(255,255,255,0.85)" : COLORS.textMuted }]}>
            {state ? "Pompe en marche" : "Pompe arrêtée"}
          </Text>
        </Pressable>

        <View style={pumpS.stats}>
          <View style={pumpS.statBox}>
            <Text style={pumpS.statLabel}>Aujourd'hui</Text>
            <Text style={pumpS.statValue}>{todayHours.toFixed(1)}<Text style={pumpS.statUnit}> h</Text></Text>
          </View>
          <View style={pumpS.statBox}>
            <Text style={pumpS.statLabel}>Cette semaine</Text>
            <Text style={pumpS.statValue}>{weekHours.toFixed(1)}<Text style={pumpS.statUnit}> h</Text></Text>
          </View>
          <View style={pumpS.statBox}>
            <Text style={pumpS.statLabel}>Eau {waterTemp.toFixed(1)} °C</Text>
            <Text style={[pumpS.statValue, { color: COLORS.metricTemp }]}>
              {recommendedHours.toFixed(1)}<Text style={pumpS.statUnit}> h</Text>
            </Text>
            <Text style={pumpS.statHint}>Recommandé/j (T°/2)</Text>
          </View>
        </View>
      </View>

      {showOverrideBadge && (
        <Pressable
          onPress={onClearOverride}
          style={pumpS.clearBtn}
          testID="pump-clear-override"
        >
          <Ionicons name="refresh-circle" size={20} color={COLORS.brand} />
          <Text style={pumpS.clearBtnText}>Revenir au planning automatique</Text>
        </Pressable>
      )}
      {!autoFiltration && (
        <Text style={pumpS.autoDisabledNote}>
          ⓘ Le pilotage auto est désactivé dans les paramètres — la pompe reste sur commande manuelle.
        </Text>
      )}
    </Card>
  );
};

const pumpS = StyleSheet.create({
  badge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: COLORS.surfaceTertiary,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.warning, marginLeft: "auto",
  },
  badgeText: { color: COLORS.warning, fontSize: FS.sm, fontWeight: "600" },
  mainRow: {
    flexDirection: "row", gap: SPACING.md, marginTop: SPACING.sm, alignItems: "stretch",
  },
  mainBtn: {
    flex: 1, minWidth: 160, minHeight: 150, borderRadius: 16, borderWidth: 2,
    alignItems: "center", justifyContent: "center", padding: SPACING.md, gap: 4,
  },
  mainBtnText: { fontSize: FS.xl, fontWeight: "700" },
  mainBtnHint: { fontSize: FS.sm },
  stats: {
    flex: 1.4, minWidth: 200, flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm,
  },
  statBox: {
    flexGrow: 1, minWidth: 100, backgroundColor: COLORS.surfaceTertiary,
    borderRadius: 12, padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
    justifyContent: "center",
  },
  statLabel: { color: COLORS.textMuted, fontSize: FS.sm },
  statValue: { color: COLORS.text, fontSize: 28, fontWeight: "700", marginTop: 2 },
  statUnit: { color: COLORS.textMuted, fontSize: FS.base, fontWeight: "500" },
  statHint: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },
  clearBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginTop: SPACING.md, paddingVertical: 12, borderRadius: 12,
    backgroundColor: COLORS.surfaceTertiary, borderWidth: 1, borderColor: COLORS.brand,
  },
  clearBtnText: { color: COLORS.brand, fontSize: FS.base, fontWeight: "700" },
  autoDisabledNote: {
    color: COLORS.textMuted, fontSize: FS.sm, marginTop: SPACING.sm, fontStyle: "italic",
  },
});

// -------- Temperature wave card --------
type WaveProps = { value: number; target: number };
export const TempWaveCard: React.FC<WaveProps> = ({ value, target }) => (
  <Card testID="widget-temp" style={{ flex: 1, minWidth: 180, overflow: "hidden" }}>
    <View style={styles.metricHead}>
      <Ionicons name="thermometer" size={18} color={COLORS.metricTemp} />
      <Text style={styles.metricLabel}>Température de l'eau</Text>
    </View>
    <View style={styles.metricRow}>
      <Text style={[styles.metricValue, { color: COLORS.metricTemp }]}>{value.toFixed(1)}</Text>
      <Text style={styles.metricUnit}>°C</Text>
    </View>
    <Text style={styles.metricTarget}>Consigne : {target.toFixed(1)} °C</Text>
    <View style={styles.waveBox}>
      <View style={[styles.wave, { backgroundColor: COLORS.metricTemp, opacity: 0.25 }]} />
      <View style={[styles.wave, { backgroundColor: COLORS.metricTemp, opacity: 0.15, bottom: 4 }]} />
    </View>
  </Card>
);

// -------- Temperature history chart --------
type HistProps = { points: { value: number; label?: string }[]; range?: "24h" | "7j"; onRangeChange?: (r: "24h" | "7j") => void };
export const HistoryChartCard: React.FC<HistProps> = ({ points, range = "24h", onRangeChange }) => {
  const data = points.map((p, i) => ({
    value: p.value,
    label: i % Math.ceil(points.length / 6) === 0 ? p.label : "",
    dataPointRadius: 0,
  }));
  return (
    <Card testID="widget-history" style={{ flex: 2, minWidth: 380 }}>
      <View style={styles.metricHead}>
        <Ionicons name="trending-up" size={18} color={COLORS.metricTemp} />
        <Text style={styles.metricLabel}>
          {range === "7j" ? "Historique température (7 jours)" : "Historique température (24h)"}
        </Text>
        {onRangeChange && (
          <View style={{ flexDirection: "row", marginLeft: "auto", gap: 4 }}>
            {(["24h", "7j"] as const).map((r) => (
              <Pressable
                key={r}
                onPress={() => onRangeChange(r)}
                style={{
                  paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
                  borderWidth: 1,
                  borderColor: range === r ? COLORS.metricTemp : COLORS.border,
                  backgroundColor: range === r ? COLORS.surfaceTertiary : "transparent",
                }}
                testID={`history-range-${r}`}
              >
                <Text
                  style={{
                    color: range === r ? COLORS.text : COLORS.textMuted,
                    fontSize: FS.sm, fontWeight: "600",
                  }}
                >
                  {r}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      <View style={{ marginTop: SPACING.sm }}>
        {data.length > 1 ? (
          <LineChart
            data={data}
            height={160}
            width={380}
            adjustToWidth
            hideDataPoints
            thickness={2}
            color={COLORS.metricTemp}
            startFillColor={COLORS.metricTemp}
            endFillColor={COLORS.metricTemp}
            startOpacity={0.4}
            endOpacity={0.02}
            areaChart
            initialSpacing={0}
            yAxisOffset={20}
            maxValue={12}
            stepValue={2}
            yAxisTextStyle={{ color: COLORS.textMuted, fontSize: 10 }}
            xAxisLabelTextStyle={{ color: COLORS.textMuted, fontSize: 10 }}
            rulesColor={COLORS.border}
            yAxisColor={COLORS.border}
            xAxisColor={COLORS.border}
            noOfSections={4}
          />
        ) : (
          <Text style={{ color: COLORS.textMuted, padding: SPACING.md }}>Aucune donnée</Text>
        )}
      </View>
    </Card>
  );
};

// -------- Pressure / water level widget --------
type PressureProps = { pressure: number; min: number; max: number };
export const PressureCard: React.FC<PressureProps> = ({ pressure, min, max }) => {
  const ok = pressure >= min && pressure <= max;
  const pct = Math.max(0, Math.min(1, (pressure - 0) / (max + 0.5)));
  return (
    <Card testID="widget-pressure" style={{ flex: 1, minWidth: 200 }}>
      <View style={styles.metricHead}>
        <Ionicons name="water" size={18} color={COLORS.metricPressure} />
        <Text style={styles.metricLabel}>Pression circuit</Text>
      </View>
      <View style={{ alignItems: "center", marginVertical: SPACING.md }}>
        <View style={{
          width: 130, height: 130, borderRadius: 65,
          borderWidth: 3, borderColor: ok ? COLORS.success : COLORS.error,
          alignItems: "center", justifyContent: "center",
          backgroundColor: COLORS.surfaceTertiary,
        }}>
          <Text style={{ color: ok ? COLORS.success : COLORS.error, fontSize: FS.xxl, fontWeight: "700" }}>
            {pressure.toFixed(2)}
          </Text>
          <Text style={{ color: COLORS.textMuted, fontSize: FS.sm }}>bar</Text>
          <Text style={{
            color: ok ? COLORS.success : COLORS.error, fontSize: FS.sm, marginTop: 4,
          }}>
            {ok ? "Niveau normal" : pressure < min ? "Trop basse" : "Trop haute"}
          </Text>
        </View>
      </View>
      <Text style={styles.metricTarget}>Plage : {min} – {max} bar</Text>
    </Card>
  );
};

// -------- Equipment toggles --------
type Eq = { id: string; name: string; icon: string; state: boolean };
type EqProps = { items: Eq[]; onToggle: (id: string, next: boolean) => void };
export const EquipmentCard: React.FC<EqProps> = ({ items, onToggle }) => {
  const iconMap: Record<string, keyof typeof Ionicons.glyphMap> = {
    engine: "cog",
    flash: "flash",
    fire: "flame",
    bulb: "bulb",
  };
  return (
    <Card testID="widget-equipment" style={{ flex: 1, minWidth: 260 }}>
      <View style={styles.metricHead}>
        <Ionicons name="settings" size={18} color={COLORS.textSecondary} />
        <Text style={styles.metricLabel}>Équipements</Text>
      </View>
      {items.map((it) => (
        <View key={it.id} style={styles.eqRow} testID={`equipment-row-${it.id}`}>
          <Ionicons name={iconMap[it.icon] || "cog"} size={20} color={COLORS.textSecondary} />
          <View style={{ flex: 1, marginLeft: SPACING.sm }}>
            <Text style={{ color: COLORS.text, fontSize: FS.base, fontWeight: "600" }}>{it.name}</Text>
            <Text style={{ color: it.state ? COLORS.success : COLORS.textMuted, fontSize: FS.sm }}>
              {it.state ? "En marche" : "Arrêté"}
            </Text>
          </View>
          <Switch
            testID={`equipment-toggle-${it.id}`}
            value={it.state}
            onValueChange={(v) => onToggle(it.id, v)}
            trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
            thumbColor={"#fff"}
          />
        </View>
      ))}
    </Card>
  );
};

// -------- Schedule widget --------
type SchedProps = {
  schedules: { id: string; start: string; end: string; enabled: boolean }[];
  totalHours: number;
  recommended?: number | null;
};
export const ScheduleCard: React.FC<SchedProps> = ({ schedules, totalHours, recommended }) => {
  function dur(s: string, e: string) {
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    const a = sh + sm / 60;
    const b = eh + em / 60;
    return b > a ? b - a : 24 - a + b;
  }
  return (
    <Card testID="widget-schedule" style={{ flex: 1, minWidth: 260 }}>
      <View style={styles.metricHead}>
        <Ionicons name="time" size={18} color={COLORS.textSecondary} />
        <Text style={styles.metricLabel}>Programmation filtration</Text>
      </View>
      {schedules.map((s) => (
        <View key={s.id} style={styles.schedRow}>
          <Text style={{ color: COLORS.text, fontSize: FS.base }}>{s.start} – {s.end}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING.sm }}>
            <Text style={{ color: COLORS.textSecondary, fontSize: FS.sm }}>{dur(s.start, s.end).toFixed(0)}h</Text>
            <View style={[styles.dot, { backgroundColor: s.enabled ? COLORS.success : COLORS.textMuted }]} />
          </View>
        </View>
      ))}
      <Text style={{ color: COLORS.brand, fontSize: FS.sm, marginTop: SPACING.sm }}>
        Total : {totalHours}h / jour
        {recommended != null && `   ·   Recommandé : ${recommended}h`}
      </Text>
    </Card>
  );
};

// -------- System state --------
type SysProps = { zigbee: string; mqtt: string; sensors: string; lastUpdate: string };
export const SystemStateCard: React.FC<SysProps> = ({ zigbee, mqtt, sensors, lastUpdate }) => {
  const t = new Date(lastUpdate).toLocaleTimeString("fr-FR");
  return (
    <Card testID="widget-system" style={{ flex: 1, minWidth: 260 }}>
      <View style={styles.metricHead}>
        <Ionicons name="shield-checkmark" size={18} color={COLORS.textSecondary} />
        <Text style={styles.metricLabel}>État système</Text>
      </View>
      {[
        { k: "Connexion Zigbee", v: zigbee },
        { k: "Connexion MQTT", v: mqtt },
        { k: "Capteurs", v: sensors },
      ].map((r) => (
        <View key={r.k} style={styles.sysRow}>
          <Text style={{ color: COLORS.textSecondary, fontSize: FS.base }}>{r.k}</Text>
          <Text style={{ color: r.v === "OK" ? COLORS.success : COLORS.error, fontSize: FS.base, fontWeight: "600" }}>{r.v}</Text>
        </View>
      ))}
      <View style={styles.sysRow}>
        <Text style={{ color: COLORS.textSecondary, fontSize: FS.base }}>Dernière mise à jour</Text>
        <Text style={{ color: COLORS.textMuted, fontSize: FS.base }}>{t}</Text>
      </View>
    </Card>
  );
};

// -------- Alerts widget --------
type AlertProps = { alerts: { id: string; title: string; message: string; level: string }[] };
export const AlertsCard: React.FC<AlertProps> = ({ alerts }) => (
  <Card testID="widget-alerts" style={{ flex: 1, minWidth: 260 }}>
    <View style={styles.metricHead}>
      <Ionicons name="notifications" size={18} color={COLORS.textSecondary} />
      <Text style={styles.metricLabel}>Alertes</Text>
    </View>
    {alerts.length === 0 ? (
      <>
        <View style={styles.sysRow}>
          <Ionicons name="checkmark-circle" size={18} color={COLORS.success} />
          <Text style={{ color: COLORS.textSecondary, marginLeft: SPACING.sm }}>Aucune alerte en cours</Text>
        </View>
        <View style={styles.sysRow}>
          <Ionicons name="checkmark-circle" size={18} color={COLORS.success} />
          <Text style={{ color: COLORS.textSecondary, marginLeft: SPACING.sm }}>Tous les paramètres sont normaux</Text>
        </View>
      </>
    ) : (
      <ScrollView style={{ maxHeight: 120 }}>
        {alerts.slice(0, 3).map((a) => (
          <View key={a.id} style={styles.alertRow}>
            <Ionicons
              name={a.level === "error" ? "alert-circle" : "warning"}
              size={18}
              color={a.level === "error" ? COLORS.error : COLORS.warning}
            />
            <View style={{ flex: 1, marginLeft: SPACING.sm }}>
              <Text style={{ color: COLORS.text, fontSize: FS.sm, fontWeight: "600" }}>{a.title}</Text>
              <Text style={{ color: COLORS.textMuted, fontSize: FS.sm }} numberOfLines={2}>{a.message}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    )}
  </Card>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  metricHead: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, marginBottom: SPACING.sm },
  metricLabel: { color: COLORS.textSecondary, fontSize: FS.base, fontWeight: "500" },
  metricRow: { flexDirection: "row", alignItems: "flex-end", gap: SPACING.xs, marginVertical: SPACING.xs },
  metricValue: { fontSize: 42, fontWeight: "700", lineHeight: 48 },
  metricUnit: { color: COLORS.textMuted, fontSize: FS.lg, marginBottom: 8 },
  metricTarget: { color: COLORS.textMuted, fontSize: FS.sm },
  gaugeWrap: { marginTop: SPACING.md },
  gaugeTrack: {
    height: 6, backgroundColor: COLORS.surfaceTertiary, borderRadius: 3, position: "relative",
  },
  gaugeFill: { height: 6, borderRadius: 3 },
  gaugeThumb: {
    position: "absolute", top: -4, width: 14, height: 14, borderRadius: 7, marginLeft: -7,
    borderWidth: 2, borderColor: COLORS.surface,
  },
  gaugeLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  waveBox: { height: 40, marginTop: SPACING.md, position: "relative", overflow: "hidden" },
  wave: {
    position: "absolute", left: -20, right: -20, height: 24, borderTopLeftRadius: 60,
    borderTopRightRadius: 60, bottom: 0,
  },
  eqRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.sm,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  schedRow: {
    flexDirection: "row", justifyContent: "space-between", paddingVertical: SPACING.sm,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  sysRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  alertRow: { flexDirection: "row", alignItems: "center", paddingVertical: SPACING.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
