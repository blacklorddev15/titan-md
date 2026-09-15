# APK releases

The Android app is a thin WebView shell (`../android/`) pointed at
`https://titan-md-repo.vercel.app`. Nothing in it is app-specific: change the
portal address from the app's menu if you host your own copy.

## Where the download comes from

The site links to **`/titan-md.apk`** — a stable filename, so the download button never has
to be edited when the version changes.

| File | Version |
|---|---|
| `titan-md.apk` | current build (repo root, what the site serves) |
| `apk/titan-md-1.0.apk` | archived copy of 1.0 |

## How a build happens

This machine and any fresh checkout have no JDK/Android SDK, so builds run in CI:

1. Edit `android/`, or bump `versionCode` / `versionName` in
   `android/app/src/main/AndroidManifest.xml` **and** `android/app/build.gradle`
   (they must match — `build.sh` reads the manifest).
2. Push to `main`. `.github/workflows/build-apk.yml` fires on any change under `android/`.
3. The workflow runs `android/build.sh`, checks the APK is a valid zip with a `classes.dex`,
   uploads it as a build artifact, then commits `titan-md.apk` and `apk/titan-md-<ver>.apk`.
4. Vercel deploys the new commit, and the download button picks it up.

To rebuild without changing anything, run the workflow manually from the Actions tab
(`workflow_dispatch`).

`android/build.sh` also works locally if you have an SDK:

```bash
ANDROID_SDK_ROOT=/path/to/sdk JAVA_HOME=/path/to/jdk ./android/build.sh
```

## Note

These are **debug-signed** builds (`android/debug.keystore`, deliberately not committed and
regenerated on each runner). Android shows an "unknown developer" warning and the app is
debuggable. Before promoting a download widely, build a release-signed APK with a keystore
you keep.
