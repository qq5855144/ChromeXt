# UserScript Script Dock

The `master` UserScript product line exposes a universal in-page Script Dock on regular top-level pages.

## Runtime rules

- The dock is injected only into the top frame.
- It reads `ChromeXt.scripts` at open time, so the icon strip represents scripts that actually initialized in the current document.
- It reads `ChromeXt.commands` at open time, so `GM_registerMenuCommand` and `GM_unregisterMenuCommand` state is current without duplicating callbacks in Kotlin.
- Menu commands invoke the original JavaScript listener in the existing script runtime. Scripts are never re-executed just to trigger a menu command.
- The UI uses a closed Shadow Root to isolate it from page CSS.

## Interaction

- The right-edge U-shaped button auto-retracts and leaves a small touch target visible.
- Tap opens a bottom sheet.
- The first icon is the ChromeXt UserScript manager (`about:blank#XT`).
- Remaining icons are running UserScripts. The first-level sheet intentionally shows icons only.
- Selecting a script opens its registered menu commands.
- Dragging the edge button changes its vertical position.
- Position is persisted globally through ChromeXt's existing `syncData`/SharedPreferences path using the reserved, non-page origin `chromext-internal://script-dock`.
- `visualViewport`, resize, orientation and fullscreen changes are handled so the control stays reachable around the soft keyboard and media fullscreen.

## Browser compatibility

The dock depends only on ChromeXt's existing JavaScript injection capability. It does not depend on a browser-specific Android context-menu implementation, making it the primary cross-browser UserScript menu entry point. Native context-menu injection remains optional and independent.
