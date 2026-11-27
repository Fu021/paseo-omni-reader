import { useSettings, useTranslation } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { readerSettings } from "../shared/reader-settings";
import { messages } from "./messages";

const sizeFields = ["inlineFormulaSize", "displayFormulaSize"] as const;
const sizePresets = ["50", "70", "85", "90", "100", "115", "125", "135", "160", "180", "200"];
const presetOptions = sizePresets.map((value) => ({ value, label: `${value}%` }));

export function ReaderSettings() {
  const settings = useSettings(readerSettings);
  const { t } = useTranslation(messages);
  const ready = settings.status === "ready";
  const error = settings.saveError || settings.status === "invalid" || settings.status === "error";

  async function recover() {
    if (settings.status === "invalid") await settings.reset();
    else await settings.reload();
  }

  return (
    <SettingsSection title={t("formulaSettings")}>
      <SettingsCard>
        {sizeFields.map((field) => {
          const value = ready ? settings.values[field] : "—";
          const options = !ready || sizePresets.includes(value) ? presetOptions
            : [...presetOptions, { value, label: `${value}%` }].sort((left, right) => Number(left.value) - Number(right.value));
          return <SettingsSelect key={field} label={t(field)} hint={t("formulaSizeHint")} value={value} options={options}
            disabled={!ready || settings.saving} onValueChange={(next) => {
              if (ready && next !== value && !settings.saving) {
                void settings.save({ ...settings.values, [field]: next }, settings.revision);
              }
            }} />;
        })}
        {error && (
          <SettingsAction label={t("readerSettingsError")}
            actionLabel={t(settings.status === "invalid" ? "resetFormulaSize" : "reloadFormulaSize")} disabled={settings.saving}
            onPress={() => { void recover(); }} />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
