# Handoff: Clock Layout Scaling and Row Spacing Regression

## Objective
Resolve remaining layout/fit issues in the 7-segment clock after recent multi-font and profile-system changes.

## Current Symptoms
1. Time row scaling is still not reliably precise in all states.
2. Visual distance between date row and time row is unstable and appears to vary unexpectedly.
3. The intended rule is: row distance should be a constant configurable factor of the effective date-row font size.
4. Default row-gap factor should be `0.5` and profile-persisted.

## Environment
- OS: macOS
- Workspace root: `7-segment-screen-clock-web`
- Active branch: `multi-font`

## Files Involved
- `index.html`
- `style.css`
- `configuration/cofiguration.js`
- `configuration/persistedState.js`
- `configuration/menu.html`
- `configuration/menu.js`

## Important Current Behavior (As Implemented)
### Scaling path
- `applyClockTransform()` in `index.html` currently:
  - clears transform (`clockInner.style.transform = "none"`) to measure in untransformed space
  - computes `baseTimeWidth = max(worst-case probe width, live time width)`
  - fits date row to `dateTargetWidth = baseTimeWidth * 0.7`
  - calls `syncVisualRowGap(dateLine, timeLine)`
  - computes final scale from measured block width/height and viewport

### Date fit path
- `fitDateLineToWidth()` in `index.html`:
  - uses `dateLine.dataset.baseFontSizePx`
  - resets date transform/font-size, measures width, and applies fitted font-size directly

### Row gap path
- `syncVisualRowGap()` in `index.html`:
  - uses `dateLine.dataset.rowGapFactor`
  - computes visual bounds from child span rects
  - sets `timeLine.style.marginTop` compensation to match desired visual gap

### Config path
- `configuration/cofiguration.js`:
  - contains per-font correction metadata (`size`, `baseline`, `letterSpacing`, `colonMargin`, `colon`)
  - writes:
    - `dateLine.dataset.baseFontSizePx`
    - `dateLine.dataset.rowGapFactor`
  - updates hidden probe typography (font sizes, colon glyph, colon margins)
  - triggers `window.applyClockTransform()` after state application

### State/profile path
- `configuration/persistedState.js`:
  - default state includes `rowGapFactor: 0.5`
  - built-in undeletable `Default` profile
  - profile select in menu loads immediately on change

## Reproduction
1. Open the clock.
2. Activate config mode (click seconds or press `x`).
3. Change one or more of:
   - numeric font
   - time font size / sec font size
   - row gap factor
4. Observe:
   - time row does not always fit as tightly/precisely as expected
   - perceived row spacing can drift

## Expected Results
1. Time row fit should be deterministic and precise for all supported fonts and profile states.
2. Row spacing should strictly follow:
   - `visualGap = rowGapFactor * effectiveDateFontSize`
3. `rowGapFactor` must remain profile-persisted and default to `0.5`.
4. Rotation behavior should remain intact (0/90/180/270 flow with normalization).

## Suspected Risk Areas
1. Mixed responsibilities between config and transform layers:
   - config writes dataset values
   - transform mutates computed layout again
2. Re-measurement order and transform reset in `applyClockTransform()` may create subtle timing/measurement mismatch.
3. Visual-gap compensation in pixel space (`getBoundingClientRect`) may conflict with baseline/line-height/font-dependent behavior.
4. Potential mismatch between probe metrics and live row metrics under specific font combinations.

## Suggested Investigation Plan
1. Instrument layout values per frame/update:
   - date base size
   - fitted date size
   - desired/actual visual gap
   - worst-case probe width vs live width
2. Decide on one authoritative source of row spacing:
   - either pure CSS/line metrics model
   - or measured visual compensation model
   - avoid hybrid drift
3. Make fit pipeline single-pass and order-stable:
   - apply typography
   - update probe
   - measure widths
   - fit date
   - compute gap
   - scale whole block
4. Validate with edge cases:
   - hour leading `1`
   - simulated `8` cycle
   - alternate colon glyph fonts
   - multiple profile switches

## Acceptance Checklist
- [ ] Time row fits accurately after any config change.
- [ ] Time row fits accurately after profile switch.
- [ ] Row distance equals configured factor of effective date font size.
- [ ] Default profile remains undeletable and loadable.
- [ ] No console/runtime errors.

## Notes For Next Model
- Main unresolved issue is not missing features; it is metric consistency and layout pipeline determinism.
- Keep edits minimal and avoid introducing new conflicting spacing mechanisms.
