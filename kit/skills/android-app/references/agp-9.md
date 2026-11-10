# Moving a project to AGP 9

Read this only when a turn moves a project to Android Gradle Plugin 9. The kit's pinned AGP is still
8.13: AGP 9 needs the host to install what it wants first (see "Pinned versions" in `SKILL.md`). Both
upstream recipes assume Android Studio; here there's no IDE, so every "use the Upgrade Assistant" or
"sync succeeds" step becomes a command below.

## Floor

Gradle wrapper 9.1 or newer, AGP 9.0.1 or newer, JDK 17 or newer (the shared JDK is 21), and
build-tools 36. KSP, if the project uses it, 2.3.6 or newer.

## Steps

1. Get to the latest 8.x first, by hand: bump the wrapper and the plugin, build, fix warnings. Don't
   jump from an old 8.x straight to 9.
2. Commit, then bump to AGP 9 and the wrapper it needs.
3. Drop the `org.jetbrains.kotlin.android` plugin: Kotlin is built in. Keep `kotlin.compose` or
   `ksp` where used.
4. Move to the new DSL. `BaseExtension` becomes `CommonExtension`; code that reached into the old
   extension types needs rewriting.
5. Set these in `gradle.properties` only while migrating, and delete them when it builds:
   `android.builtInKotlin`, `android.newDsl`, `android.uniquePackageNames`,
   `android.enableAppCompileTimeRClass`. Never add `android.disallowKotlinSourceSets=false`.
6. Verify with `./gradlew help`, then the scheme's full check under `citadel-heavy`. Don't run
   `clean` while verifying: it hides stale-output problems you want to see.

## Defaults that change

Fix each one in the project, or set it back on purpose and say why:

- `resValues` and shader compilation are off.
- R8 runs in strict full mode, so keep rules that relied on looser behaviour fail at runtime.
- `targetSdk` defaults to `compileSdk`.
- Unit tests run only for the tested build type.
- The default Java target moves from 8 to 11.

## Not for plain apps

The Kotlin Multiplatform parts of the JetBrains recipe (the KMP library plugin, source-set moves)
don't apply to an app with one Android module.
