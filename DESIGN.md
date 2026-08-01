# Seedream Studio Design System

## 1. Atmosphere & Identity

Seedream Studio is a compact creative command center: dark, focused, and dense enough for repeated generation work without feeling like an admin dashboard. Its signature is the violet selection glow used only to show active tools, selected prompts, references, and primary actions.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---|---|
| Canvas | `--bg` | `#0a0a0f` | App background and deep controls |
| Surface | `--surface` | `#111118` | Header and side panels |
| Card | `--card` | `#16161f` | Cards, inputs, grouped controls |
| Border | `--border` | `#252535` | Default separators and outlines |
| Active border | `--border-active` | `#4f46e5` | Selected control edge |
| Accent | `--accent` | `#6d28d9` | Primary actions and selected states |
| Accent strong | `--accent2` | `#7c3aed` | Primary gradient support |
| Focus glow | `--glow` | `#8b5cf6` | Focus, hover, and active labels |
| Text | `--text` | `#e8e8f0` | Primary copy |
| Muted text | `--muted` | `#6b6b8a` | Metadata and secondary labels |
| Strong muted text | `--muted-strong` | `#a5a5bd` | Inactive interactive labels on dark surfaces |
| Destructive | `--danger` | `#ef4444` | Delete actions and errors |
| Success | `--success` | `#10b981` | Connected and completed states |
| Warning | `--warning` | `#f59e0b` | Cautions and partial support |

Accent color communicates state or action; it is not decorative. New colors must first be added to this table.

## 3. Typography

- Primary: `Syne`, sans-serif.
- Data and metadata: `DM Mono`, monospace.
- Page and empty-state title: 16px, 700.
- Control and body text: 12-13px, 400-700.
- Item title and labels: 10-11px, 600-700.
- Metadata: 9-10px, 400-600.
- Body copy must not be introduced below 12px. Existing compact metadata may remain at 9-11px.

## 4. Spacing & Layout

All spacing uses a 4px base unit.

| Token | Value | Usage |
|---|---|---|
| `--space-1` | 4px | Tight inline gaps |
| `--space-2` | 8px | Compact controls and list gaps |
| `--space-3` | 12px | Mobile padding and input gaps |
| `--space-4` | 16px | Panel and card padding |
| `--space-5` | 20px | Header and strip padding |
| `--space-6` | 24px | Desktop generation area |

- Desktop uses a central workspace with two off-canvas utility panels.
- Mobile uses a single full-height library drawer below the persistent header.
- Breakpoints: compact mobile at 560px, mobile/tablet at 900px.
- Mobile interactive targets are at least 44px in either the control itself or its visible label container.

## 5. Components

### Mobile Library Drawer

- **Structure**: persistent tab bar followed by one active panel: Prompts, References, or Studio.
- **Variants**: prompt library, reference library, settings/history.
- **Spacing**: `--space-2` through `--space-4`.
- **States**: closed, open, active tab, pressed tab.
- **Accessibility**: buttons expose `aria-selected`; Escape and backdrop close the drawer; focus remains visible.
- **Motion**: desktop drawer movement uses 200ms transform; mobile panel changes are immediate to keep the header stable.

### Prompt Folder

- **Structure**: folder header, count, nested folders, prompt cards.
- **States**: collapsed, expanded, selected prompt, queue-selected prompt.
- **Accessibility**: folder header is a button-sized target; prompt checkbox has a 44px label target on mobile.
- **Motion**: chevron rotation only.

### Prompt Card

- **Structure**: queue checkbox, name and preview, move/delete actions.
- **States**: default, hover, active, focus, queue selected.
- **Accessibility**: tapping the card applies the prompt; destructive actions remain separate and labeled.
- **Mobile behavior**: applying a prompt closes the library and brings the prompt editor into view.

### Reference Folder

- **Structure**: folder header, selected/total count, thumbnail grid, nested folders.
- **States**: collapsed, expanded, reference selected.
- **Accessibility**: thumbnails use descriptive names and at least 64px mobile targets.

### Reference Selection Bar

- **Structure**: selected count, clear action, Done action.
- **States**: zero selected, selected, pressed.
- **Mobile behavior**: stays visible while selecting multiple images; Done closes the library and returns to generation.

### Reference Groups

- **Structure**: compact horizontal group rail above the prompt with stacked previews, name, image count, save-current action, and separate delete action.
- **States**: empty guidance, available, active selection, save dialog, persistence error.
- **Behavior**: saves the current ordered selection as a named group and replaces active references with all group images in one click; each group is normalized to 10 unique images maximum.
- **Persistence**: groups synchronize through the server and are included in folder/full backups, imports, and clear-all data.
- **Accessibility**: applying and deleting are separate named controls; all primary mobile targets are at least 44px.

### Generation Output Card

- **Structure**: media, metadata, copy, download, delete actions.
- **States**: loading, ready, error.
- **Accessibility**: media has descriptive alt text and actions have labels.

### xAI Quick Action

- **Structure**: persistent compact header action opening the existing xAI Prompt Generator.
- **States**: default, hover/focus, generator dialog open.
- **Accessibility**: exposes a dialog relationship and keeps a 44px mobile target.
- **Behavior**: carries the current generation prompt into the generator and focuses the idea field.

### Prompt Keyword Editor

- **Structure**: category-level `Edit keywords` mode with separate keyword selection and delete buttons.
- **States**: browsing, editing, selected keyword, empty category.
- **Accessibility**: no nested interactive controls; edit state uses `aria-pressed`; delete controls are 44px on mobile.
- **Behavior**: deletion remains scoped to the selected category and persists to the server immediately.

### Gallery Prompt Copy

- **States**: available, copied confirmation, unavailable for legacy outputs, manual-copy fallback.
- **Accessibility**: disabled legacy actions explain why no prompt exists; successful copy is announced through a live region.
- **Mobile behavior**: when clipboard access is blocked on plain HTTP, the full prompt opens selected in a readable fallback dialog.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---|---|---|
| Micro | 150ms | ease-out | Press and selection feedback |
| Standard | 200ms | ease-in-out | Drawer and tab changes |
| Emphasis | 400ms | ease | Generated output entry |

- Animate only `transform`, `opacity`, and `filter`.
- Respect `prefers-reduced-motion` for drawer and output transitions.
- A prompt selection returns directly to the prompt editor.
- Reference selection supports multiple taps before the user chooses Done.

## 7. Depth & Surface

Strategy: mixed tonal shift and borders. Surfaces are separated by `--surface`, `--card`, and `--bg`; borders clarify interactive groups. Shadows are reserved for overlays and lightboxes. Nested cards use tighter radii than outer panels.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA.
- Body text contrast target: 4.5:1; large text and component boundaries: 3:1.
- Every interactive control requires a visible focus state and an accessible name.
- Mobile primary interactions require 44px touch targets; reference thumbnails are at least 64px.
- Drawer content must remain keyboard reachable and independently scrollable.
- Reduced-motion preferences disable non-essential transitions.

### Relevant Personas

- A phone user selecting several references one-handed.
- A repeat creator with many nested prompt folders.
- A keyboard user moving between library tabs and generation controls.

### Accepted Debt

| Item | Location | Why accepted | Exit |
|---|---|---|---|
| Legacy compact metadata below 12px | Existing studio cards | Preserved to avoid a broad visual redesign in this mobile usability change | Revisit during a full typography pass |
| Legacy emoji icons | Existing studio controls | Replacing the complete icon set is outside this focused interaction change | Replace with a consistent SVG icon set in a dedicated pass |
