import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "../lib/theme";

/**
 * Touch-friendly overlay scrollbar for Raspberry Pi kiosk mode.
 * Web-only. Uses pointer events (works with mouse and touch alike).
 * Auto-attaches to the largest visible scrollable div inside #root.
 */
export const TouchScrollbar: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [handleTop, setHandleTop] = useState(0);
  const [handleH, setHandleH] = useState(80);
  const [trackH, setTrackH] = useState(400);

  const activeEl = useRef<HTMLElement | null>(null);
  const dragState = useRef<{ startY: number; startTop: number } | null>(null);
  const holdTimer = useRef<any>(null);

  // Find the largest visible scrollable element in #root
  const findScrollable = (): HTMLElement | null => {
    if (typeof document === "undefined") return null;
    const root = document.getElementById("root");
    if (!root) return null;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    const walk = (node: Element) => {
      const cs = window.getComputedStyle(node as HTMLElement);
      if (
        (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
        (node as HTMLElement).scrollHeight > (node as HTMLElement).clientHeight + 4
      ) {
        const el = node as HTMLElement;
        const area = el.clientWidth * el.clientHeight;
        if (area > bestArea) {
          best = el;
          bestArea = area;
        }
      }
      for (const c of Array.from(node.children)) walk(c);
    };
    walk(root);
    return best;
  };

  // Poll ~30fps to keep the handle in sync with the scroll position
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let raf = 0;
    const tick = () => {
      const el = findScrollable();
      activeEl.current = el;
      if (el) {
        const contentH = el.scrollHeight;
        const visibleH = el.clientHeight;
        const scrollTop = el.scrollTop;
        const maxScroll = contentH - visibleH;
        if (maxScroll > 20 && trackH > 0) {
          const trackUseful = Math.max(80, trackH);
          const hh = Math.max(80, (visibleH / contentH) * trackUseful);
          const hy = maxScroll > 0 ? (scrollTop / maxScroll) * (trackUseful - hh) : 0;
          setHandleH(hh);
          setHandleTop(hy);
          setVisible(true);
        } else {
          setVisible(false);
        }
      } else {
        setVisible(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [trackH]);

  const scrollBy = useCallback((amount: number) => {
    const el = activeEl.current;
    if (!el) return;
    el.scrollBy({ top: amount, behavior: "smooth" });
  }, []);

  const startHold = (dir: 1 | -1) => {
    scrollBy(dir * 200);
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = setInterval(() => scrollBy(dir * 200), 300);
  };
  const stopHold = () => {
    if (holdTimer.current) { clearInterval(holdTimer.current); holdTimer.current = null; }
  };

  // Handle drag via pointer events (works for touch & mouse)
  const onHandlePointerDown = (e: any) => {
    const el = activeEl.current;
    if (!el) return;
    e.target?.setPointerCapture?.(e.pointerId);
    dragState.current = { startY: e.clientY, startTop: el.scrollTop };
  };
  const onHandlePointerMove = (e: any) => {
    if (!dragState.current) return;
    const el = activeEl.current;
    if (!el) return;
    const dy = e.clientY - dragState.current.startY;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const trackUseful = Math.max(80, trackH);
    // pixel-of-drag ratio: content_scroll / track_scroll = maxScroll / (trackUseful - handleH)
    const ratio = maxScroll / Math.max(1, trackUseful - handleH);
    el.scrollTop = Math.max(0, Math.min(maxScroll, dragState.current.startTop + dy * ratio));
  };
  const onHandlePointerUp = (e: any) => {
    dragState.current = null;
    e.target?.releasePointerCapture?.(e.pointerId);
  };

  // Track tap-to-jump
  const onTrackPress = (e: any) => {
    const el = activeEl.current;
    if (!el) return;
    // Ignore if the tap is on the handle itself
    const layoutY = e.nativeEvent?.locationY ?? 0;
    if (layoutY >= handleTop && layoutY <= handleTop + handleH) return;
    const dir = layoutY < handleTop ? -1 : 1;
    scrollBy(dir * Math.min(el.clientHeight * 0.7, 400));
  };

  if (Platform.OS !== "web") return null;

  return (
    <View
      style={[styles.wrap, !visible && { opacity: 0.35 }]}
      pointerEvents="box-none"
      testID="touch-scrollbar"
    >
      <Pressable
        style={styles.arrowBtn}
        onPress={() => scrollBy(-Math.min(activeEl.current?.clientHeight ? activeEl.current.clientHeight * 0.7 : 300, 400))}
        onLongPress={() => startHold(-1)}
        onPressOut={stopHold}
        testID="touch-scrollbar-up"
      >
        <Ionicons name="chevron-up" size={28} color="#fff" />
      </Pressable>

      <Pressable
        style={styles.track}
        onPress={onTrackPress}
        onLayout={(e) => setTrackH(e.nativeEvent.layout.height)}
        testID="touch-scrollbar-track"
      >
        {visible && (
          <View
            style={[styles.handle, { top: handleTop, height: handleH }]}
            {...({
              onPointerDown: onHandlePointerDown,
              onPointerMove: onHandlePointerMove,
              onPointerUp: onHandlePointerUp,
              onPointerCancel: onHandlePointerUp,
            } as any)}
            testID="touch-scrollbar-handle"
          >
            <View style={styles.handleGrip} />
            <View style={styles.handleGrip} />
            <View style={styles.handleGrip} />
          </View>
        )}
      </Pressable>

      <Pressable
        style={styles.arrowBtn}
        onPress={() => scrollBy(Math.min(activeEl.current?.clientHeight ? activeEl.current.clientHeight * 0.7 : 300, 400))}
        onLongPress={() => startHold(1)}
        onPressOut={stopHold}
        testID="touch-scrollbar-down"
      >
        <Ionicons name="chevron-down" size={28} color="#fff" />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 6,
    top: 72,           // below the header
    bottom: 40,        // above the footer
    width: 44,
    alignItems: "center",
    zIndex: 100,
  },
  arrowBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: COLORS.brand,
    alignItems: "center", justifyContent: "center",
    marginVertical: 4,
    borderWidth: 1, borderColor: "#fff",
  },
  track: {
    flex: 1,
    width: 40,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginVertical: 4,
    overflow: "hidden",
  },
  handle: {
    position: "absolute",
    left: 2, right: 2,
    backgroundColor: COLORS.brand,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  handleGrip: {
    width: 18, height: 2, backgroundColor: "#fff",
    marginVertical: 1, borderRadius: 1, opacity: 0.9,
  },
});
