# Jarvis for Android

A native app (Kotlin, Jetpack Compose, Material 3) in `android/`. It is a client of your Jarvis server: integrations, ranking, readback checks and Hermes all stay on the server. The app adds native screens, an instant-open cache, widgets, a Quick Settings tile, share-to-Jarvis, and notifications. One APK works with any Jarvis, because the server address comes from pairing.

The web app is still there for desktop and for setup (connections, onboarding). Chrome's "Install app" also still works, but the native app is the better phone experience.

## What you can do from the app

- **Home**: Now, the household glance (next event, Daily Compass, home status) and Later. Swipe a card right to complete (or acknowledge) and left to snooze. ⋮ opens Pin, Open, and **Ask Hermes about this**. Pull to refresh. The last copy shows instantly, also offline, and is labelled when it's saved data.
- **Ask Hermes about anything**: "Ask Hermes" on Home, any card, Skylight, Home controls, Todos and Daily Compass. Attach chips (**Today, Skylight, Home, Todos, Daily Compass, Initiatives**) make the server attach a fresh snapshot of that source to your question. "Is the garage open, and do I have time before soccer?" with Home + Skylight attached gives Hermes both.
- **Chat**: conversations, live replies, tool activity, inline **approval** buttons (allow once, this conversation, always, deny) and **Stop**.
- **Alerts**: inbox and all, swipe right = handled, left = dismiss, Mark all read. The badge counts unread actionable alerts.
- **Home controls**: exceptions, allowlisted controls with a confirm dialog against live state, success only after Home Assistant reads back the new state, never queued. The health panel shows counts only, and unknown is never 0.
- **Who's signed in decides what shows**: the app reads `/api/auth/me` (cached for offline) and hides tabs and screens the person can't use. A kid's phone gets no Chat tab and no Finance. The server still enforces every call.
- **Hermes or Claude**: when both are set up, Ask shows a Hermes / Claude choice (remembered on the phone). Claude conversations show a Claude tag; conversations someone shared with the household open read-only.
- **Lights, doors and cameras** (Home controls): every door and lock with its state, light switches (success only after Home Assistant reads back), and camera stills loaded on tap and never cached.
- **Search** (More → Search): conversations, todos, devices, calendar, finance items, whatever you can see.
- **Finance** (More → Finance): status, the two labelled totals, the reserve, funds and what needs fixing. **Hide amounts on this phone** replaces every amount with •••••. The check-in itself opens on the web.
- **Skylight** (agenda + chores), **Todos** (complete/snooze), **Daily Compass** (start/continue the check-in, mark complete with readback).
- **Settings**: theme, Material You colors, compact density, **Home layout** (reorder/hide sections, shared with the web), notification status and test, sign out.

### Widgets and shortcuts

| Widget        | Shows                                             | Tap                                               |
| ------------- | ------------------------------------------------- | ------------------------------------------------- |
| Next up       | 1–5 top actions (configurable), alert count       | row opens it; ✓ completes it (server readback)    |
| Home status   | home exceptions, alert count, unreachable sources | opens Home controls                               |
| Ask Hermes    | a capture bar with 🏠 / 📅 shortcuts              | opens Ask Hermes (with Home or Skylight attached) |
| Daily Compass | today's check-in state and your next event        | opens Daily Compass / Skylight                    |

Widgets refresh every 30 minutes, and right after anything you do in the app or any push. Also: a **Quick Settings tile** (Ask Hermes), long-press app shortcuts (Ask Hermes, Alerts, Home controls), and **Share → Jarvis** from any app to ask Hermes about a link or text.

## Install

1. One-time signing key: create it once and keep it. Every update must be signed with the same key.

   ```sh
   keytool -genkeypair -keystore jarvis.jks -alias jarvis -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 jarvis.jks   # macOS: base64 -i jarvis.jks
   ```

   Store `jarvis.jks` and its password in your password manager. Never commit it.

2. GitHub → repo **Settings → Secrets and variables → Actions → Secrets**: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`jarvis`), `ANDROID_KEY_PASSWORD` (the same as the store password unless you set another).
3. **Actions → Android app → Run workflow**, tick **publish a GitHub release**. Open the release on your phone and install the APK. Allow "install unknown apps" for your browser when asked.
4. Open Jarvis on the web → **Settings → Phones → Show pairing code**. In the app, tap **Scan pairing code**, or type the server address and code. Codes work once and expire after 10 minutes.

A release dispatch fails before Java/Gradle setup unless all four persistent signing secrets are present. Publishing also requires the persistent-signing output. Only non-release CI may use a throwaway key: fine to try it, but the next build will not install over it. This guard does not prove the key is valid; the actual build and APK signature verification must still pass.

If you use `JARVIS_AUTH_MODE=proxy` (Authelia/Authentik in front), let requests with an `Authorization: Bearer jdv_…` header through to Jarvis for `/api/*`. The phone authenticates with its device token, not the proxy session. Pairing itself (`POST /api/devices/pair`) must also be reachable.

## Notifications (Firebase, once, about 5 minutes)

Android only delivers notifications to a closed app through Firebase Cloud Messaging. Jarvis talks to FCM directly with no Firebase SDK on the server, and the APK carries no Firebase file: the app gets its Firebase settings from your server after pairing.

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (Analytics not needed).
2. **Add app → Android**, package name `com.nickbolles.jarvis`. Download **google-services.json** and skip the SDK steps.
3. **Project settings → Service accounts → Generate new private key** (a JSON file).
4. Jarvis on the web → **Settings → Phones → Phone notifications**: paste both files and save. The service-account key is stored encrypted and never sent to phones. Env alternatives: `JARVIS_FCM_GOOGLE_SERVICES(_FILE)`, `JARVIS_FCM_SERVICE_ACCOUNT(_FILE)`.
5. In the app: **Settings → Send a test**.

Phone notifications follow the same rules as web push: categories, quiet hours (critical alerts bypass them), dedupe and escalation. Channels: Critical home alerts, Hermes needs you, Alerts, Status. Each can be tuned in Android settings. Notifications have **Mark handled** and open the right screen when tapped.

## Security

- Pairing codes are single use, expire in 10 minutes, are stored hashed, and are throttled like passcode login. Only a browser session can mint one.
- The device token is stored hashed on the server and encrypted on the phone (Android Keystore, AES-GCM). It's excluded from backups and device transfer, so a restored phone must pair again.
- Sign a phone out from the app or from **Settings → Phones** on the web. A revoked phone gets "signed out" on its next request.
- HTTPS only, except plain HTTP to `localhost`, `*.local`, `*.lan`, `*.home.arpa` and `10.0.2.2` for trying a home server before it has a certificate. The app warns when it isn't using HTTPS.

## Development

```sh
cd android
./gradlew testDebugUnitTest        # unit, contract, Compose UI tests (Robolectric)
./gradlew verifyRoborazziDebug     # same + compare screenshots with app/src/test/screenshots
./gradlew recordRoborazziDebug     # re-record screenshots after an intended UI change
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
../scripts/android-live-check.sh   # the real client against a real server + mock upstreams (needs npm run build)
```

Needs JDK 21 and the Android SDK with `platforms;android-37.2` (compile) and build tools 37.

How it's tested:

- **Contract**: `test/mobile.test.ts` (server) records real API responses into `contracts/api`. `ContractTest` parses every one into the Kotlin models. If the server drops or retypes a field the app uses, the server test fails until the fixtures (and the app) are updated: `UPDATE_API_FIXTURES=1 npx vitest run test/mobile.test.ts`.
- **Screenshots** (Roborazzi, like the Playwright visual tests): every screen in light and dark, 200% text on a small phone, and all four widgets rendered through RemoteViews. They use the recorded server responses and a pinned clock.
- **Interaction**: Compose UI tests for card actions, confirm-before-control, chat attach chips and pairing input.
- **Network**: SSE parsing of a recorded run stream, reconnect with `Last-Event-ID`, never inferring completion from a closed stream, error mapping.
- **Live**: `scripts/android-live-check.sh` pairs, asks about Skylight + Home, streams a run, completes a todo, closes the garage with readback, handles an alert, signs out.

CI (`.github/workflows/android.yml`) runs all but the live check on every change under `android/` or `contracts/api/`, uploads screenshot diffs when one changes, and builds the signed APK. Run it manually with **record screenshots** to commit new baselines.
