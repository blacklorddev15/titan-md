# Titan Anime MD · Pairing Dashboard

Recovered from the live Vercel deployment (original `titan-md` repo was deleted).

- `index.html` / `styles.css` / `script.js` / `admin.html` — static dashboard
- `api/pairing.js` — Neon-native pairing bridge (titan_pair_requests + titan_heartbeat + titan_sessions)
  (its source was lost with the deleted repo). Replace it with the real function
  source when available and remove the pinned `UPSTREAM` URL.

## Android app

`android/` is a WebView shell around this portal (`com.aether.titanmd`, version 1.0). It has
no Gradle wrapper and no dependencies beyond `android.jar`, so `android/build.sh` builds it
with nothing but the SDK command-line tools.

Builds run in CI, because a fresh checkout has no JDK or Android SDK:

1. Push any change under `android/`.
2. `.github/workflows/build-apk.yml` runs `android/build.sh`, verifies the APK, and commits it
   as `titan-md.apk` (the stable name `index.html` links to) plus `apk/titan-md-<version>.apk`.
3. Vercel deploys the commit and the download button picks it up.

Icons are generated, not hand-drawn: `python3 android/tools/make_icon.py`.

See `apk/README.md` for the release/rollback note.
