import * as fs from "fs/promises";
import * as path from "path";

// These checks constrain model-supplied paths and symlink targets. Validation
// and filesystem access are separate operations: concurrent directory/symlink
// replacements can still race them. This is not a complete filesystem sandbox.
class AccessDeniedError extends Error {}

type FileRoot = { lexical: string; canonical: string };

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AccessDeniedError("Access denied");
  }
}

async function canonicalize(fullPath: string, allowDanglingLeaf = false): Promise<string> {
  let existing = fullPath;
  let isSymlink = false;
  while (true) {
    try {
      isSymlink = (await fs.lstat(existing)).isSymbolicLink();
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = path.dirname(existing);
      if (parent === existing) throw e;
      existing = parent;
    }
  }
  try {
    const canonical = await fs.realpath(existing);
    return path.resolve(canonical, path.relative(existing, fullPath));
  } catch (e) {
    // A dangling file link can create its leaf when its actual parent exists.
    // Missing directory links, loops and other errors must not be skipped.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !allowDanglingLeaf || !isSymlink || existing !== fullPath) throw e;
    const target = await fs.readlink(existing);
    // Keep '..' intact until realpath follows any directory symlinks in the
    // parent. path.resolve/join here would change the link's filesystem meaning.
    const parent = path.isAbsolute(target)
      ? path.dirname(target)
      : `${path.dirname(existing)}${path.sep}${path.dirname(target)}`;
    const canonicalParent = await fs.realpath(parent);
    const resolvedTarget = await canonicalize(path.join(canonicalParent, path.basename(target)), true);
    // Keep directory intent so a trailing separator is not turned into a valid
    // file creation; writeFile will report its normal filesystem error.
    return target.endsWith("/") || target.endsWith(path.sep) ? `${resolvedTarget}${path.sep}` : resolvedTarget;
  }
}

async function resolveFilePath(boundary: FileRoot, filePath: string, allowDanglingLeaf = false): Promise<string> {
  const requested = path.resolve(boundary.lexical, filePath);
  assertContained(boundary.lexical, requested);
  const resolved = await canonicalize(requested, allowDanglingLeaf);
  assertContained(boundary.canonical, resolved);
  return resolved;
}

export async function readFiles(root: string, filePaths: string[]): Promise<string> {
  let boundary: FileRoot;
  try {
    const lexical = path.resolve(root);
    boundary = { lexical, canonical: await canonicalize(lexical) };
  } catch (e) {
    return "";
  }
  let context = "";
  for (const p of filePaths) {
    try {
      const fullPath = await resolveFilePath(boundary, p);
      const content = await fs.readFile(fullPath, "utf-8");
      context += `\n--- FILE: ${p} ---\n${content}\n`;
    } catch (e) {}
  }
  return context;
}

export async function writeFile(root: string, relPath: string, content: string): Promise<string> {
  try {
    const lexical = path.resolve(root);
    assertContained(lexical, path.resolve(lexical, relPath));
    const boundary = { lexical, canonical: await canonicalize(lexical) };
    let fullPath = await resolveFilePath(boundary, relPath, true);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    fullPath = await resolveFilePath(boundary, relPath, true);
    await fs.writeFile(fullPath, content, "utf-8");
    return `Successfully wrote: ${relPath}`;
  } catch (e: any) {
    if (e instanceof AccessDeniedError) return `Error: Access denied to ${relPath}`;
    return `Error writing ${relPath}: ${e.message}`;
  }
}
