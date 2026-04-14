# Apple Code Signing & Notarization

How the macOS build is signed and notarized for distribution outside the Mac App Store.

## Overview

- **Certificate type**: Developer ID Application
- **Distribution**: Direct download (not Mac App Store)
- **Notarization**: Automated via electron-builder in GitHub Actions
- **Team ID**: QTQNY54EJM

## Setup (already done)

### 1. Generate a Certificate Signing Request (CSR)

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout ~/yo-dev-id.key \
  -out ~/yo-dev-id.csr \
  -subj "/emailAddress=YOUR_EMAIL/CN=YOUR_NAME/C=US"
```

### 2. Create the certificate on Apple Developer Portal

- Go to https://developer.apple.com/account/resources/certificates
- Click `+` → select **Developer ID Application**
- Upload the `.csr` file
- Download the `.cer` file

### 3. Install Apple's intermediate certificate

- Go to https://www.apple.com/certificateauthority/
- Download **Developer ID - G2** (under Intermediate Certificates)
- Double-click to install in Keychain

### 4. Import certificate and key into Keychain

- Double-click the `.cer` to import
- Import the private key: Keychain Access → File → Import Items → select `~/yo-dev-id.key`
- Verify it shows under **My Certificates** with a private key attached

### 5. Export as .p12

Either from Keychain (right-click → Export as .p12) or command line:

```bash
openssl pkcs12 -export -out ~/yo-dev-id.p12 \
  -inkey ~/yo-dev-id.key \
  -in ~/path/to/developerID_application.cer
```

### 6. Generate an app-specific password

- Go to https://account.apple.com
- Sign-In and Security → App-Specific Passwords
- Click `+`, name it "yo-notarize"
- Copy the generated password

### 7. Add GitHub Actions secrets

Go to repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|--------|-------|
| `CSC_LINK` | `base64 -i ~/yo-dev-id.p12 \| pbcopy` (paste clipboard) |
| `CSC_KEY_PASSWORD` | Password set when exporting the .p12 |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 6 |
| `APPLE_TEAM_ID` | 10-char Team ID from developer.apple.com/account |

## How it works

1. `electron-builder` reads `CSC_LINK` and `CSC_KEY_PASSWORD` to code-sign the app
2. `hardenedRuntime: true` in electron-builder.yml enables macOS hardened runtime
3. `entitlements.mac.plist` grants necessary permissions (JIT, network, file access)
4. `notarize: true` tells electron-builder to submit to Apple's notarization service
5. Apple notarizes the app using `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
6. The stapled DMG/ZIP can be opened without Gatekeeper warnings

## Files

| File | Purpose |
|------|---------|
| `electron-builder.yml` | Build config with signing + notarization settings |
| `entitlements.mac.plist` | macOS entitlements for hardened runtime |
| `.github/workflows/build.yml` | CI workflow that passes signing secrets |

## Renewing

- Apple Developer membership ($99/yr) must stay active
- Certificate is valid for 5 years
- If certificate expires: create new one, export new .p12, update `CSC_LINK` secret
- App-specific passwords don't expire unless you revoke them

## Troubleshooting

**"Yo is damaged and can't be opened"** — app isn't signed/notarized. Quick fix for testing:
```bash
xattr -cr /Applications/Yo.app
```

**"Certificate not trusted"** — install Apple's Developer ID G2 intermediate cert from https://www.apple.com/certificateauthority/

**Notarization fails** — check that `APPLE_APP_SPECIFIC_PASSWORD` is valid and the Apple Developer membership is active.
