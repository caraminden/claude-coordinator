# Citadel's build images (H1)

The images a machine's **Builds** role runs heavy builds in (`specs/heavy-jobs-across-machines.md` in the shared
folder, sections 3 and 4): one per toolchain, the same for every scheme.

| Image | What's in it | Cache volume |
|---|---|---|
| `citadel-build-android` | JDK 21 and Node 24 through mise, Android SDK 36, build-tools 36.1.0 and 35.0.0 (as `tools/android/install-sdk.sh` pins them), Gradle 8.14.3, and the self-test `citadel-hello-apk` | `citadel-gradle` at `/cache/gradle` |
| `citadel-build-node` | Node 24 and npm | `citadel-npm` at `/cache/npm` |
| `citadel-build-rust` | rustup and stable Rust | `citadel-cargo` |

`images.json` pins each by digest: the server reads it and hands it to the agent in each Builds Set up
(`src/role-setup.ts`, `public/role-setup-agent.mjs`), which pulls them and makes the volumes.

## Changing one

1. Edit its Dockerfile (the build context is this folder) and push your branch: `.github/workflows/build-images.yml`
   builds all three, builds the hello APK in the Android one, pushes them to `ghcr.io/caraminden/`, and prints the
   `images.json` lines in its summary (`gh run view <id>`).
2. Paste those lines into `images.json` and ship it. A machine takes the new images at its next Set up.

A new package on ghcr.io starts private: its owner makes it public once (the package's settings, "Change
visibility"), since machines pull with no sign-in.
