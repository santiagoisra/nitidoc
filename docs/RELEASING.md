# Releasing the Android app

Two channels: GitHub Releases (a signed APK people download directly) and
Google Play (a signed AAB). Both need the same signing key.

## 1. Create the signing key — once, and never again

**This is the step you cannot redo.** Android identifies an app by its
signature, so if this keystore is lost, no future build can update an existing
install. On Google Play that means the listing is dead: you would have to
publish under a new package name and every user would have to reinstall by hand.

Back it up somewhere you would not lose a passport.

```bash
keytool -genkeypair -v -keystore nitidoc-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias nitidoc
```

`keytool` ships with the JDK. It will prompt for a store password, a key
password and your details. `-validity 10000` (~27 years) is the conventional
choice: a key that expires mid-life leaves you unable to ship updates.

Put the `.jks` somewhere outside the repo, then create
`android/keystore.properties`:

```properties
storeFile=C:/path/outside/the/repo/nitidoc-release.jks
storePassword=...
keyAlias=nitidoc
keyPassword=...
```

Both `*.jks` and `keystore.properties` are git-ignored. This repository is
public and AGPL — a committed key would let anyone sign a build that Android
accepts as an update to this app.

Without that file the release build still compiles; it just comes out
unsigned, so a missing key fails at publish time rather than breaking every
developer's build.

## 2. Bump the version

**`versionName` comes from `package.json`.** Edit `version` there and the
Android build picks it up — `android/app/build.gradle` reads the file at
configure time. There is nothing to keep in step, which is the point: the two
copies drifted before v1.0.0 (0.1.0 in one, "1.0" in the other, v1.0.0 on the
tag). A missing or unreadable version fails the build rather than substituting
a placeholder.

**`versionCode` is still by hand**, in `android/app/build.gradle`. It MUST
increase on every single upload to Play — a re-used one is rejected, and that
is the most common failed-upload cause. It is deliberately not derived from the
semver: Play's rule means you sometimes need a second build of the SAME
version (a rejected upload, a packaging fix), and a formula would make that
impossible without inventing a version bump to carry it.

Tag the git release to match `package.json`, e.g. `v1.1.0`.

## 3. Build

```bash
npm run android:apk    # GitHub Releases -> android/app/build/outputs/apk/release/
npm run android:aab    # Google Play     -> android/app/build/outputs/bundle/release/
```

Both run `android:sync` first, which rebuilds the web bundle with
`NITIDOC_NATIVE=1` (no service worker) and copies it into the native project.
Never publish a build made without that sync: it would ship whatever `dist/`
happened to be lying around.

Verify what you are about to publish, rather than assuming:

```bash
"$ANDROID_HOME/build-tools/36.0.0/apkanalyzer" manifest print app-release.apk
```

Check the `versionCode`, that `android.permission.CAMERA` is present, and that
`assets/public/opencv/opencv.js` is bundled — an APK missing it starts fine and
then fails to detect anything.

## 4. GitHub Releases

```bash
gh release create v1.1.0 android/app/build/outputs/apk/release/app-release.apk \
  --title "Nitidoc v1.1.0" --notes "..."
```

Say plainly in the notes that Android will warn about installing from an
unknown source, and why that is expected for a directly-distributed APK.

## 5. Google Play

One-time setup:

- Developer account — USD 25, paid once.
- Play requires an **AAB**, not an APK, for new apps. That is `android:aab`.
- **Privacy policy at a public URL.** Required, and Nitidoc's case is unusually
  easy to state honestly: scanning, detection and PDF export all run on-device,
  and the scan history is local IndexedDB. Nothing is uploaded. Say exactly
  that.
- Data safety form — declare no data collection and no sharing, matching the
  above.
- Content rating questionnaire.
- Store listing: title, short and full description, at least two screenshots
  per form factor, a 512×512 icon, and a 1024×500 feature graphic.
- Camera permission justification: it is the app's core function, which is the
  straightforward case to make.

Then upload the AAB to a testing track first (internal testing is instant and
has no review), install from it, and confirm on a real device before promoting
to production. Production review takes days, and a rejected release costs a
full cycle.

## Signing key on Play

Play Console will offer **Play App Signing**: Google holds the app signing key
and re-signs your uploads. It is worth taking. If your upload key is ever lost
or compromised you can request a replacement, whereas losing a self-managed app
signing key is unrecoverable. The keystore from step 1 then becomes the *upload*
key, which is the thing you can recover from.

This does not help GitHub Releases, where the APK is signed by your key alone —
another reason to guard it regardless.
