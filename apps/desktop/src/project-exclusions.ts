const ABSOLUTE_PROJECT_PATH = /^(?:\/|[A-Za-z]:\/|\/\/)/;

export function normalizeExcludedProjectPath(value: unknown) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  if (!ABSOLUTE_PROJECT_PATH.test(normalized)) return "";
  const networkPath = normalized.startsWith("//");
  normalized = normalized.replace(/\/{2,}/g, "/");
  const segments = normalized.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  const prefix = networkPath ? "//" : normalized.startsWith("/") ? "/" : "";
  normalized = `${prefix}${resolved.join("/")}`.replace(/\/+$/, "");
  if (!normalized || normalized === "/" || /^[A-Za-z]:$/.test(normalized)) return "";
  return normalized;
}

export function normalizeExcludedProjectPaths(values: unknown) {
  if (!Array.isArray(values)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeExcludedProjectPath(value);
    if (!normalized) continue;
    const key = comparisonPath(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(normalized);
    if (paths.length >= 64) break;
  }
  return paths;
}

export function projectPathIsExcluded(projectPath: unknown, excludedProjectPaths: unknown) {
  const candidate = comparisonPath(normalizeExcludedProjectPath(projectPath));
  if (!candidate) return false;
  return normalizeExcludedProjectPaths(excludedProjectPaths).some((excludedPath) => {
    const excluded = comparisonPath(excludedPath);
    return candidate === excluded || candidate.startsWith(`${excluded}/`);
  });
}

export function excludedProjectPathsCovering(projectPath: unknown, excludedProjectPaths: unknown) {
  return normalizeExcludedProjectPaths(excludedProjectPaths).filter((excludedPath) =>
    projectPathIsExcluded(projectPath, [excludedPath])
  );
}

function comparisonPath(value: string) {
  return process.platform === "win32" || process.platform === "darwin"
    ? value.toLocaleLowerCase("en-US")
    : value;
}
