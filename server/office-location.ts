import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import preparedDirectory from "./generated/office-location";

const installationSource = `export default ${JSON.stringify(preparedDirectory)};\n`;

async function matchesInstallation(directory: string) {
  return (await readFile(join(directory, "server", "generated", "office-location.ts"), "utf8").catch(() => null))
    === installationSource;
}

export async function officeDirectory() {
  const directory = preparedDirectory;
  if (await matchesInstallation(directory)) return directory;

  let version = directory;
  while (dirname(version) !== version && basename(dirname(version)) !== ".staging") version = dirname(version);
  if (basename(dirname(version)) === ".staging") {
    const managedRoot = dirname(dirname(version));
    const packagePath = relative(version, directory);
    for (const plugin of await readdir(managedRoot, { withFileTypes: true })) {
      if (!plugin.isDirectory() || plugin.name.startsWith(".")) continue;
      const pluginRoot = join(managedRoot, plugin.name);
      for (const revision of await readdir(pluginRoot, { withFileTypes: true }).catch(() => [])) {
        if (!revision.isDirectory()) continue;
        const candidate = join(pluginRoot, revision.name, packagePath);
        if (await matchesInstallation(candidate)) return candidate;
      }
    }
  }
  throw new Error("The bundled Office renderer is missing from this installation.");
}
