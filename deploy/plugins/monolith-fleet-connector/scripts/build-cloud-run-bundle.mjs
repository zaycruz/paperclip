#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import manifest from "../src/manifest.js";

const packageRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultOutDir = path.join(packageRoot, "dist", "cloud-run", "monolith-fleet-connector");
const defaultImagePath = "/opt/paperclip/plugins/monolith-fleet-connector";

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function usage() {
  console.error([
    "Usage: node scripts/build-cloud-run-bundle.mjs [--out-dir <path>] [--image-path <path>] [--force]",
    "",
    "Builds a Cloud Run image-ready local-path Paperclip plugin bundle.",
    "The generated directory is meant to be copied into the Paperclip image,",
    "then installed with POST /api/plugins/install and isLocalPath=true.",
  ].join("\n"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertCleanOutput(outDir, force) {
  if (!(await exists(outDir))) return;
  const entries = await fs.readdir(outDir);
  if (entries.length === 0) return;
  if (!force) {
    throw new Error(`Output directory is not empty: ${outDir}. Pass --force to replace it.`);
  }
  await fs.rm(outDir, { recursive: true, force: true });
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyTree(srcDir, destDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function listFiles(root) {
  const results = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await visit(root);
  return results.sort();
}

async function sha256(filePath) {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function build() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }

  const outDir = path.resolve(argValue("--out-dir", defaultOutDir));
  const imagePath = argValue("--image-path", defaultImagePath).replace(/\/+$/, "");
  if (!path.isAbsolute(imagePath)) {
    throw new Error("--image-path must be an absolute in-container path");
  }

  await assertCleanOutput(outDir, hasFlag("--force"));
  await fs.mkdir(outDir, { recursive: true });

  for (const filename of ["README.md", "package.json", "package-lock.json"]) {
    await copyFile(path.join(packageRoot, filename), path.join(outDir, filename));
  }
  await copyTree(path.join(packageRoot, "src"), path.join(outDir, "src"));
  await copyTree(path.join(packageRoot, "scripts"), path.join(outDir, "scripts"));
  await copyTree(path.join(packageRoot, "tests"), path.join(outDir, "tests"));

  const installPayload = {
    packageName: imagePath,
    isLocalPath: true,
  };
  await fs.writeFile(
    path.join(outDir, "paperclip-install-payload.json"),
    `${JSON.stringify(installPayload, null, 2)}\n`,
    "utf8",
  );

  const files = await listFiles(outDir);
  const fileRecords = [];
  for (const filePath of files) {
    const relativePath = path.relative(outDir, filePath);
    fileRecords.push({
      path: relativePath,
      bytes: (await fs.stat(filePath)).size,
      sha256: await sha256(filePath),
    });
  }

  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const artifactManifest = {
    schemaVersion: 1,
    packageName: pkg.name,
    packageVersion: pkg.version,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    paperclipPlugin: pkg.paperclipPlugin,
    cloudRun: {
      imagePath,
      installEndpoint: "POST /api/plugins/install",
      installPayload,
      dockerfileSnippet: [
        `COPY packages/paperclip-fleet-connector/dist/cloud-run/monolith-fleet-connector ${imagePath}`,
        `RUN cd ${imagePath} && npm ci --omit=dev --ignore-scripts`,
      ],
      notes: [
        "Use this local-path install only when the same bundle path is baked into every Cloud Run revision.",
        "Do not point Cloud Run at a workstation path; the path must exist inside the Paperclip container image.",
        "For dynamic npm installs, publish the package to a registry instead and install by package name/version.",
      ],
    },
    files: fileRecords,
  };

  await fs.writeFile(
    path.join(outDir, "cloud-run-artifact-manifest.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
    "utf8",
  );

  const finalFiles = await listFiles(outDir);
  console.log(JSON.stringify({
    status: "ready",
    outDir,
    imagePath,
    installPayload,
    fileCount: finalFiles.length,
    manifestPath: path.join(outDir, "cloud-run-artifact-manifest.json"),
  }, null, 2));
}

build().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
