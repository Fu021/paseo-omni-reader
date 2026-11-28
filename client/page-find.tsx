import { memo } from "react";
import { View } from "react-native";
import type { PageGlyph, PageTextMatch } from "../shared/contracts";
import { glyphBands } from "./page-selection";
import type { Size } from "./viewport-geometry";

export const PageFindOverlay = memo(function PageFindOverlay({ width, height, glyphs, matches, active }: Size & {
  glyphs: PageGlyph[]; matches: PageTextMatch[]; active?: PageTextMatch;
}) {
  let index = 0;
  const bands = glyphBands(glyphs, ([start, end]) => {
    while (matches[index] && matches[index][2] <= start) index++;
    const match = matches[index];
    return match && match[1] < end ? match === active ? "active" : "match" : undefined;
  });
  return (
    <View pointerEvents="none" importantForAccessibility="no" testID="omni-page-find-highlights"
      style={{ position: "absolute", left: 0, top: 0, width, height }}>
      {bands.map(({ left, top, right, bottom, mark }, index) => (
        <View key={index} testID={mark === "active" ? "omni-page-find-active" : undefined}
          style={{ position: "absolute", left: left * width, top: top * height, width: (right - left) * width,
            height: (bottom - top) * height, backgroundColor: mark === "active" ? "#f59e0b" : "#facc15", opacity: 0.5 }} />
      ))}
    </View>
  );
});
