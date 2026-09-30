# Installing Jarvis on Android

Jarvis is a Progressive Web App: Chrome installs it as a real app (WebAPK) with its own icon, full-screen window, share-sheet entry, app shortcuts and push notifications.

1. Deploy Jarvis behind HTTPS (Traefik certificate). Install and push both require HTTPS.
2. On the phone, open `https://<your Jarvis domain>` in **Chrome** and sign in.
3. Either tap **Install Jarvis** in onboarding (Install step), or ⋮ → **Install app**.
4. Open Jarvis from the home screen → Settings → Notifications → **Enable push on this device** → **Send a test alert**.
5. Long-press the icon for shortcuts (Ask Hermes, Alerts, Home controls). Share any text or link to **Jarvis** to start a Hermes capture.

Tip (Android 14+): Settings → Apps → Jarvis → Notifications to allow "critical" alerts to use heads-up display.

## Optional: an APK / Play-Store style wrapper (Trusted Web Activity)

Only needed if you want a sideloadable APK. Use [PWABuilder](https://www.pwabuilder.com) → enter your Jarvis URL → Android → download the package. Then set in `.env`:

```
JARVIS_TWA_ASSETLINKS=<package id>=<SHA-256 signing fingerprint>
```

and restart; Jarvis serves `/.well-known/assetlinks.json` so the wrapper runs full-screen without a URL bar.
