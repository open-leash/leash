import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findDockerExecutable(options: {
  envPath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  isExecutable?: (candidate: string) => boolean;
} = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const delimiter = platform === "win32" ? ";" : ":";
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const suffixes = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const directories = [
    ...(options.envPath ?? process.env.PATH ?? "").split(delimiter),
    platformPath.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(platform === "darwin"
      ? ["/Applications/Docker.app/Contents/Resources/bin"]
      : []),
  ].filter(Boolean);
  const isExecutable = options.isExecutable ?? ((candidate: string) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

  for (const directory of [...new Set(directories)]) {
    for (const suffix of suffixes) {
      const candidate = platformPath.join(directory, `docker${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return "docker";
}
