import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'wasm/opacity-retarget/Cargo.toml');
const buildDirectory = mkdtempSync(
  path.join(os.tmpdir(), 'opacity-retarget-wasm-'),
);
const targetDirectory = path.join(buildDirectory, 'target');
const artifact = path.join(
  targetDirectory,
  'wasm32-unknown-unknown/release/opacity_retarget.wasm',
);
const output = path.join(root, 'src/opacity_retarget.wasm');
const wasmTarget = 'wasm32-unknown-unknown';

try {
  const installedTargets = execFileSync(
    'rustup',
    ['target', 'list', '--installed'],
    { encoding: 'utf8' },
  );
  if (!installedTargets.split(/\r?\n/).includes(wasmTarget)) {
    execFileSync('rustup', ['target', 'add', wasmTarget], {
      stdio: 'inherit',
    });
  }

  execFileSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      manifest,
      '--target',
      wasmTarget,
      '--release',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: targetDirectory,
        RUSTFLAGS: [process.env.RUSTFLAGS, '-C target-feature=+simd128']
          .filter(Boolean)
          .join(' '),
      },
      stdio: 'inherit',
    },
  );
  copyFileSync(artifact, output);
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}
