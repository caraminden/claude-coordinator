#!/usr/bin/env node
// Pin Citadel's shared Android shell (kit/android-shell, #1138) into a contraption's Capacitor app, or say which
// version it pins. Run from the app's repo root:
//
//   node <this skill>/scripts/android-shell.mjs install   pack the kit's shell into <android>/citadel-shell/, point the
//                                                         Capacitor root's package.json at it, npm install, cap sync
//   node <this skill>/scripts/android-shell.mjs status    the pinned version against the kit's
//
// The app's citadel-app.json "capacitor" field ({ "root", "android" }) says where its Capacitor root and Android
// project are (default: the repo root and android/); --root and --android override. The packed .tgz lives inside the
// Android project on purpose: Citadel's APK build (src/apk-build.ts) rebuilds when that folder changes, so moving to a
// newer shell is a commit there that the next deploy builds. Commit the .tgz, package.json and package-lock.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@citadel/android-shell';
const SHELL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'android-shell');

function fail(msg) {
  console.error(`android-shell: ${msg}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function places(args) {
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let cap = {};
  if (existsSync('citadel-app.json')) cap = readJson('citadel-app.json').capacitor ?? {};
  const root = resolve(flag('root') ?? cap.root ?? '.');
  const android = resolve(flag('android') ?? cap.android ?? join(relative('.', root) || '.', 'android'));
  if (!existsSync(join(root, 'package.json'))) fail(`no package.json in the Capacitor root ${root} (set --root)`);
  if (!existsSync(join(android, 'app'))) fail(`${android} isn't an Android project (no app/ folder; set --android)`);
  return { root, android };
}

function kitVersion() {
  if (!existsSync(join(SHELL, 'package.json'))) fail(`the kit's shell isn't at ${SHELL}`);
  return readJson(join(SHELL, 'package.json')).version;
}

function pinned(root) {
  const spec = readJson(join(root, 'package.json')).dependencies?.[NAME];
  const m = spec?.match(/citadel-android-shell-(\d+\.\d+\.\d+)\.tgz$/);
  return { spec: spec ?? null, version: m ? m[1] : null };
}

function install(args) {
  const { root, android } = places(args);
  const version = kitVersion();
  const dir = join(android, 'citadel-shell');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^citadel-android-shell-.*\.tgz$/.test(f)) rmSync(join(dir, f));
  execFileSync('npm', ['pack', SHELL, '--pack-destination', dir, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = join(dir, `citadel-android-shell-${version}.tgz`);
  if (!existsSync(tgz)) fail(`npm pack made no ${tgz}`);
  const pkgFile = join(root, 'package.json');
  const pkg = readJson(pkgFile);
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [NAME]: `file:${relative(root, tgz)}` };
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  // A re-pack of the same version (trying a change to the shell) keeps its name, so npm would keep the old copy: drop it
  // and name the tarball, which also rewrites its lock entry.
  rmSync(join(root, 'node_modules', ...NAME.split('/')), { recursive: true, force: true });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', pkg.dependencies[NAME]], { cwd: root, stdio: 'inherit' });
  execFileSync('npx', ['--no-install', 'cap', 'sync', 'android'], { cwd: root, stdio: 'inherit' });
  console.log(`Pinned ${NAME} ${version}: ${relative('.', tgz)}. Commit it with ${relative('.', pkgFile)} and its lock file.`);
}

function status(args) {
  const { root } = places(args);
  const kit = kitVersion();
  const { spec, version } = pinned(root);
  if (!spec) console.log(`Not pinned: the kit's shell is ${kit}. Run install.`);
  else if (version === kit) console.log(`Pinned ${version}, the kit's newest.`);
  else console.log(`Pinned ${version ?? spec}; the kit has ${kit}. Run install to move, then build and try it.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'install') install(rest);
else if (cmd === 'status') status(rest);
else fail('usage: android-shell.mjs install|status [--root <capacitor root>] [--android <android project>]');
