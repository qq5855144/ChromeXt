# ChromeXt Extension-only product line

This branch is intentionally independent from the UserScript product maintained on `master`.

## Branch contract

- `master` is the stable UserScript line and must not receive WebExtension runtime work.
- `extension-only` is the WebExtension line and must not initialize or expose the UserScript runtime.
- Do not share UserScript storage, GM APIs, UserScript install flow, or UserScript manager state with the extension runtime.
- Extension lifecycle, package management, API bridge, background/service-worker host, content-script injection, popup/options pages and network APIs must live behind extension-specific classes.
- Existing UserScript source files inherited from the historical base may temporarily remain as unreferenced code while the extension line is cleaned up, but they must never be initialized from the extension-only entry points.
- Prefer independent tests and artifact names for the extension line.

## Development order

1. Remove UserScript runtime entry points from Chromium and WebView paths.
2. Establish `ExtensionHook`, `ExtensionRuntime`, extension package storage and manager UI.
3. Implement Manifest V2/V3 content scripts and isolated extension page hosting.
4. Implement background/service-worker lifecycle and message routing.
5. Implement popup/action/options behavior.
6. Implement WebExtension APIs incrementally with explicit unsupported behavior.
7. Add real network enforcement for DNR/webRequest without synchronous DevTools probing on normal navigation.
8. Physically delete inherited UserScript/GM code once no extension-only source references it.

The key invariant is simple: a bug or architectural experiment in `extension-only` must never destabilize the UserScript `master` branch.
