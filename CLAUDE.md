# Autlaut — Known Issues

## UI Inconsistencies

### Inconsistent color palette
- 8+ different grays used with no clear hierarchy: `#e0e0e0`, `#ccc`, `#aaa`, `#888`, `#666`, `#555`, `#333`, `#222`
- Background color mismatch: popup body is `#111`, player/cards are `#1a1a2e`
- Files: `extension/popup.css`, `extension/content.css`

### Button styling inconsistencies
- `.primary-btn` padding: `10px`, font: `13px`
- `.danger-btn` padding: `8px`, font: `12px`
- `.icon-btn` padding: `7px 8px`, no explicit font-size
- Files: `extension/popup.css`

### `!important` overrides on speed button
- `#kokoro-speed-btn` uses `!important` on 4 properties, suggesting specificity issues that should be resolved structurally
- File: `extension/content.css:149-153`

## Accessibility

### No focus indicators on buttons
- Only input elements have `:focus` styles; buttons have no visible focus ring
- Keyboard-only users cannot tell which button is focused
- Files: `extension/popup.css`, `extension/content.css`

### Missing ARIA labels
- Delete button in history uses `&#x2715;` (x symbol) with no `aria-label` — screen readers will not announce its purpose
- FAB button and player controls rely on `title` attribute only, which is not announced by all screen readers
- Files: `extension/popup.js:158`, `extension/content.js` (createPlayer, createFAB)

### Low contrast text
- History meta text uses `#555` on `#1a1a2e` background — fails WCAG AA contrast requirements
- Inactive tab text `#888` on `#111` background is borderline
- Offline status dot `#666` on `#111` is hard to distinguish
- File: `extension/popup.css`

### No semantic form markup
- Settings section uses `<div>` elements instead of a proper `<form>` with `<fieldset>` grouping
- File: `extension/popup.html:31-53`

## UX Concerns

### Auto-download without user consent
- `saveBlob()` in `content.js:303-311` automatically triggers a file download every time TTS is generated
- Users expect TTS to play audio, not silently download a WAV file
- Consider making this opt-in via settings, or replacing with a download button in the player

### Z-index stacking conflicts
- Progress overlay and FAB both use `z-index: 2147483647` (max 32-bit int)
- Player uses `2147483646`
- When progress overlay is visible and the player appears, they can overlap unpredictably
- Files: `extension/content.css:6,62,175`

### No loading/disabled state on Save Settings button
- Clicking "Save Settings" has no visual feedback during save (no spinner, no disabled state)
- Only a text status message appears after completion
- File: `extension/popup.js:51-62`, `extension/popup.css`

### Error display inconsistency
- Some errors use toast notifications (`showError()` in content.js)
- Some use inline status text (`.preview-status` in popup)
- Some use browser `confirm()` dialog (clear history in popup)
- No unified error handling pattern across the extension
