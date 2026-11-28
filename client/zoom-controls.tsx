import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Keyboard, Platform, Text, TextInput, View, type GestureResponderEvent, type ViewStyle } from "react-native";
import { useTranslation } from "@getpaseo/plugin/client";
import { Control, useWebTitle, type Theme } from "./controls";
import { messages } from "./messages";
import { clamp, maxZoomPercent, minZoomPercent } from "./viewport-geometry";
import { bindWebSliderKeys } from "./web";

const trackInset = 8;

function sliderPosition(percent: number) {
  return percent <= 100
    ? (percent - minZoomPercent) / (100 - minZoomPercent) / 2
    : 0.5 + (percent - 100) / (maxZoomPercent - 100) / 2;
}

function ZoomSlider({ value, disabled, compact, theme, change }: {
  value: number; disabled: boolean; compact: boolean; theme: Theme; change: (percent: number) => void;
}) {
  const { t } = useTranslation(messages);
  const label = t("zoomSlider");
  const slider = useWebTitle(label);
  const width = useRef(0);
  const left = useRef(0);
  const changeRef = useRef(change);
  const web = Platform.OS === "web";
  const percent = clamp(value, minZoomPercent, maxZoomPercent);
  const position = `${sliderPosition(percent) * 100}%` as const;
  useLayoutEffect(() => { changeRef.current = change; }, [change]);
  useEffect(() => {
    if (web && !disabled) return bindWebSliderKeys(slider.current, (value) => changeRef.current(value));
  }, [web, disabled, slider]);

  const move = ({ nativeEvent }: GestureResponderEvent) => {
    if (width.current <= trackInset * 2) return;
    const fraction = clamp((nativeEvent.pageX - left.current - trackInset) / (width.current - trackInset * 2), 0, 1);
    const next = fraction <= 0.5
      ? minZoomPercent + fraction * 2 * (100 - minZoomPercent)
      : 100 + (fraction - 0.5) * 2 * (maxZoomPercent - 100);
    change(Math.round(next));
  };
  return (
    <View
      ref={slider}
      testID="omni-zoom-slider"
      accessible
      role="slider"
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      aria-valuemin={minZoomPercent}
      aria-valuemax={maxZoomPercent}
      aria-valuenow={percent}
      aria-valuetext={`${value}%`}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (!disabled) change(percent + (nativeEvent.actionName === "increment" ? 5 : -5));
      }}
      tabIndex={web ? disabled ? -1 : 0 : undefined}
      onLayout={({ nativeEvent }) => { width.current = nativeEvent.layout.width; }}
      onStartShouldSetResponder={() => !disabled}
      onResponderGrant={(event) => {
        const { pageX, locationX } = event.nativeEvent;
        left.current = pageX - locationX;
        move(event);
      }}
      onResponderMove={move}
      onResponderTerminationRequest={() => false}
      style={[
        {
          width: compact ? 104 : 116, minWidth: web ? 64 : 28, flexShrink: 1,
          height: web ? compact ? 40 : 32 : 32, justifyContent: "center", opacity: disabled ? 0.45 : 1,
        },
        web && ({ touchAction: "none", cursor: disabled ? "default" : "pointer" } as ViewStyle),
      ]}
    >
      <View pointerEvents="none" style={{
        marginHorizontal: trackInset, height: 4, borderRadius: 2, backgroundColor: theme.colors.border,
      }}>
        <View style={{ position: "absolute", left: "50%", top: -3, width: 1, height: 10, backgroundColor: theme.colors.foregroundMuted }} />
        <View style={{
          position: "absolute", left: position, top: -5, width: 14, height: 14, marginLeft: -7,
          borderRadius: 7, backgroundColor: theme.colors.foreground,
        }} />
      </View>
    </View>
  );
}

export function ZoomControls({ scale, disabled, compact, theme, stepZoom, setZoom }: {
  scale: number; disabled: boolean; compact: boolean; theme: Theme;
  stepZoom: (factor: number) => void; setZoom: (scale: number) => void;
}) {
  const { t } = useTranslation(messages);
  const label = t("zoomPercent");
  const field = useWebTitle(label);
  const [draft, setDraft] = useState<string>();
  const web = Platform.OS === "web";
  const percent = Math.round(scale * 100);
  const apply = (percent: number) => setZoom(clamp(percent, minZoomPercent, maxZoomPercent) / 100);
  const commit = () => {
    const value = draft?.trim().replace(/%$/, "").trim();
    if (value && /^\d+$/.test(value)) apply(Number(value));
    setDraft(undefined);
  };
  return (
    <View style={{ flexDirection: "row", flexShrink: 1, alignItems: "center", gap: 3 }}>
      <Control title={t("zoomOut")} icon="Minus" small={!web} disabled={disabled || percent <= minZoomPercent}
        onPress={() => stepZoom(1 / 1.25)} theme={theme} compact={compact} />
      <ZoomSlider value={percent} change={apply} disabled={disabled} compact={compact} theme={theme} />
      {!web && draft !== undefined
        ? <Control title={t("applyZoom")} icon="Check" theme={theme} compact={compact} small disabled={disabled}
            onPress={() => { commit(); Keyboard.dismiss(); }} />
        : <Control title={t("zoomIn")} icon="Plus" small={!web} disabled={disabled || percent >= maxZoomPercent}
            onPress={() => stepZoom(1.25)} theme={theme} compact={compact} />}
      <View ref={field} style={{
        flexDirection: "row", alignItems: "center", gap: 4, height: web && compact ? 36 : 28, width: 62,
        borderWidth: 1, borderRadius: 5, borderColor: theme.colors.border, paddingRight: 5,
        opacity: disabled ? 0.45 : 1,
      }}>
        <TextInput
          accessibilityLabel={label}
          testID="omni-pdf-zoom"
          value={draft ?? (disabled ? "" : String(percent))}
          editable={!disabled}
          inputMode="numeric"
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={7}
          selectTextOnFocus
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, textAlign: "right", fontSize: 13, paddingVertical: 0 }}
        />
        <Text importantForAccessibility="no" style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>%</Text>
      </View>
    </View>
  );
}
