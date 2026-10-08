# AssembleAtEase app (iOS and Android)

The app is a native shell (Capacitor 8) opening the shared entry page at
`https://www.assembleatease.com/app`. Customers use the existing booking and
tracking flows; Easers sign in to their existing workspace. Route selection
does not grant an account role or bypass server authorization. Website fixes reach the app
immediately; a store update is only needed when this `mobile/` folder changes.

What the app adds on top of the website:

- Native push notifications for job offers and messages (Firebase Cloud Messaging)
- Camera and photo library access for job photos
- An offline screen, app icon and splash screen
- No "Install app" button and no browser push prompt inside the app

The website is unaffected: `assets/js/native-app.js` does nothing outside the
app, `api/_push.js` returns the same web push result when no app is installed,
and `.vercelignore` keeps this folder out of the website deploy.
`scripts/test-native-app.mjs` checks all of this on every `npm run test:launch`.

- App ID (bundle / package): `com.assembleatease.easer`
- App name: AssembleAtEase
- Apple app record: 6820654960 (version 1.0, Prepare for Submission)
- Node.js 22+; Xcode 26+; iOS 15+ target
- The stable internal bundle ID keeps its existing `.easer` suffix for both roles.

## One-time setup

Do these in order. Each step only has to be done once.

### 1. Run migration 103 (Supabase)

Run `api/migrations/103_native_push_tokens.sql` in the Supabase SQL editor.
Until it runs, the app works but does not register for notifications.

### 2. Firebase (native push)

1. console.firebase.google.com: create a project named AssembleAtEase.
2. Add an Android app with package `com.assembleatease.easer`; download
   `google-services.json`.
3. Add an iOS app with bundle ID `com.assembleatease.easer`; download
   `GoogleService-Info.plist`.
4. Apple Developer: Certificates, Identifiers & Profiles, Keys, create a key with
   Apple Push Notifications service (APNs). In Firebase, Project settings, Cloud
   Messaging, Apple app configuration, upload that key with its Key ID and Team ID.
5. Firebase, Project settings, Service accounts, Generate new private key. In
   Vercel, add environment variable `FIREBASE_SERVICE_ACCOUNT` with the file's
   contents (raw JSON or base64), for Production. Redeploy.

### 3. Apple App Store Connect

1. Certificates, Identifiers & Profiles, Identifiers: register
   `com.assembleatease.easer` with the Push Notifications capability.
2. App Store Connect: create the app (iOS, bundle ID above, name
   "AssembleAtEase").
3. Users and Access, Integrations, App Store Connect API: create a key with the
   App Manager role (used by Codemagic to upload builds).

### 4. Google Play Console

1. Create the app "AssembleAtEase".
2. Google Cloud: create a service account, give it access in Play Console
   (Users and permissions) with release permissions, and download its JSON key.

### 5. Codemagic (builds; no Mac needed)

1. codemagic.io: add the GitHub repository. It reads `codemagic.yaml` at the root.
2. Team settings, Integrations, App Store Connect: add the API key from step 3
   and name it exactly `AssembleAtEase App Store Connect`.
3. Environment variables:
   - group `firebase`: `FIREBASE_GOOGLE_SERVICES_JSON` = base64 of
     `google-services.json`; `FIREBASE_IOS_PLIST` = base64 of
     `GoogleService-Info.plist`
   - group `google_play`: `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` = the Play
     service account JSON
4. Code signing identities: Android, generate an upload keystore named
   `easer_upload_key` (keep a backup; Google needs it for every update).
   iOS, let Codemagic fetch or create the App Store distribution certificate and
   profile for `com.assembleatease.easer`.

## Building a release

In Codemagic, start `easer-ios` (uploads to TestFlight) and `easer-android`
(uploads to the Google Play internal testing track as a draft). Builds never
start automatically from a website push.

## Before submitting for review

- Apple and Google both need a working sign-in for the reviewer. Create a test
  Easer account (owner dashboard, create test Easer) that is approved and can see
  sample jobs, and put its email and password in the App Review notes.
- Store listing: privacy policy `https://www.assembleatease.com/privacy`,
  support `https://www.assembleatease.com/contact`, screenshots of Jobs, a job
  detail, messages and payouts from a phone.
- Apple asks why the app uses the camera: job photos of finished work (already
  in `Info.plist`).

## Local commands

```bash
cd mobile
npm install
npx cap sync          # after changing capacitor.config.json or plugins
npm run assets        # regenerate icons/splash from resources/
```

## Unified app validation

Run `node scripts/test-native-app.mjs`, `node scripts/test-native-routes.mjs`,
and `node scripts/test-native-privacy.mjs` from the repository root. Native
customer pages do not register Easer push tokens. Optional website Ads/GA/CRM
tracking and advertising attribution are disabled inside Capacitor. Website
consent behavior remains unchanged.

A local test pass does not prove a signed iOS build. Before App Review, verify
both routes, card authentication/return, camera upload, check-in, notifications,
account deletion, and offline recovery on the actual TestFlight build. Capture
store screenshots from that build using synthetic review records. Never use a
real customer job or credential in screenshots or review access.
