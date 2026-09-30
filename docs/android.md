# Installing Jarvis on Android

Jarvis is a Progressive Web App: Chrome installs it as a real app (WebAPK) with its own icon, full-screen window, share-sheet entry, app shortcuts and push notifications.

1. Deploy Jarvis behind HTTPS (Traefik certificate). Install and push both require HTTPS.
2. On the phone, open `https://<your Jarvis domain>` in **Chrome** and sign in.
3. Either tap **Install Jarvis** in onboarding (Install step), or ⋮ → **Install app**.
4. Open Jarvis from the home screen → Settings → Notifications → **Enable push on this device** → **Send a test alert**.
5. Long-press the icon for shortcuts (Ask Hermes, Alerts, Home controls). Share any text or link to **Jarvis** to start a Hermes capture.

Tip (Android 14+): Settings → Apps → Jarvis → Notifications to allow "critical" alerts to use heads-up display.

## Optional: an APK built by CI (Trusted Web Activity)

The Chrome install above is enough for most uses. The APK is the same web app inside a thin Android wrapper (`android/`, package `com.nickbolles.jarvis`). It gives you a sideloadable file, a stable app identity, and Android-native notification settings, and it's the path to the Play Store later. Chrome still renders Jarvis, so every web deploy updates the app without a new APK.

What the wrapper includes: full-screen launch, splash screen, adaptive and themed (Android 13+) icon, long-press shortcuts (Ask Hermes, Alerts, Home controls), share-to-Jarvis, Jarvis links opening in the app, and web push delegated to the app so notifications show as "Jarvis".

### One-time setup

1. **Signing key**: create it once and keep it forever. Every update must be signed with the same key.

   ```sh
   keytool -genkeypair -keystore jarvis.jks -alias jarvis -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 jarvis.jks   # macOS: base64 -i jarvis.jks
   ```

   Keep `jarvis.jks` and its password somewhere safe (password manager). Don't commit it.

2. In GitHub → repo **Settings → Secrets and variables → Actions**:
   - Secrets: `ANDROID_KEYSTORE_BASE64` (the base64 output), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`jarvis`), `ANDROID_KEY_PASSWORD` (the same as the store password unless you set another).
   - Variable: `JARVIS_DOMAIN`, e.g. `jarvis.nickbolles.com`.

3. **Actions → Android APK → Run workflow**. Tick "publish a GitHub release" to get a direct `.apk` download link.

4. The run summary prints a line like `JARVIS_TWA_ASSETLINKS=com.nickbolles.jarvis=AB:CD:…`. Put it in Jarvis's `.env` and restart Jarvis. Check `https://<domain>/.well-known/assetlinks.json` shows it.

5. On the phone, open the release (or the run's artifact) and install the APK. Allow "install unknown apps" for your browser when asked. If Chrome's installed Jarvis is also on the phone, remove one of them to avoid two icons.

If the app shows a URL bar at the top, the assetlinks fingerprint doesn't match the key that signed the APK: redo step 4.

Without the signing secrets, CI still builds and signs with a **throwaway** key: fine for a quick try, but the next build won't install over it.

### Building locally

```sh
cd android
./gradlew assembleRelease -PjarvisHost=jarvis.example.com   # needs JDK 17+ and the Android SDK (ANDROID_HOME)
```

Set `JARVIS_KEYSTORE`, `JARVIS_KEYSTORE_PASSWORD`, `JARVIS_KEY_ALIAS` and `JARVIS_KEY_PASSWORD` to sign. Icons come from `public/icons/icon.svg` via `npm run icons`.
