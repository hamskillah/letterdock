# DESIGN.md — Letterdock Operator UI ("Harbor Ledger")

## Creative Direction
**Harbor Ledger: Sovereign Maritime Precision.** A quiet ocean-slate shell framing ruled mail queues and configuration tables. Sender, subject, timestamp, and state occupy stable positions. A separate reader gives the actual message room to breathe.

## 1. Visual Foundations

### Semantic Design Tokens
```css
:root {
  /* Light Theme (Canvas & Surfaces) */
  --canvas: #f8fafc;
  --surface: #ffffff;
  --chrome: #f1f5f9;
  --hover: #eff4f8;
  --selected: #e0f1f4;
  --divider: #e2e8f0;
  --control-border: #94a3b8;

  /* Typography */
  --text: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;

  /* Brand / Action Accent (Maritime Spruce) */
  --accent: #155e75;
  --on-accent: #ffffff;
  --accent-hover: #104c60;
  --accent-active: #0e3b4a;
  --focus: #155e75;

  /* Operational States */
  --success: #166534;
  --success-bg: #dcfce7;
  --warning: #854d0e;
  --warning-bg: #fef3c7;
  --danger: #991b1b;
  --danger-bg: #fee2e2;
  --info: #1e40af;
  --info-bg: #dbeaf2;

  /* Radii & Shadows */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
}

[data-theme="dark"] {
  /* Dark Theme (Abyssal Slate) */
  --canvas: #070b12;
  --surface: #0d131f;
  --chrome: #141d2e;
  --hover: #1a2538;
  --selected: #163644;
  --divider: #1e293b;
  --control-border: #475569;

  /* Typography */
  --text: #f8fafc;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;

  /* Brand / Action Accent */
  --accent: #14b8a6;
  --on-accent: #042f2e;
  --accent-hover: #2dd4bf;
  --accent-active: #0d9488;
  --focus: #38bdf8;

  /* Operational States */
  --success: #22c55e;
  --success-bg: #052e16;
  --warning: #f59e0b;
  --warning-bg: #451a03;
  --danger: #f87171;
  --danger-bg: #450a0a;
  --info: #38bdf8;
  --info-bg: #082f49;
}
```

### Typography
- UI Chrome & Prose: `Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Headers, RFC 822, Code, MIME, Tokens: `JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace`

### Density System
- **Comfortable (Default):**
  - Message row height: `~52px`
  - Sidebar width: `15rem (240px)`
  - Padding: generous 12px / 16px insets
- **Compact (High-Density Triage):**
  - Message row height: `~36px`
  - Tight single-line tabular view for power operators
  - Micro badges (18px height)

## 2. Keyboard Navigation Model
- `j` / `k` or `Down` / `Up`: Navigate to next / previous message
- `Enter`: Open focused message / read detail
- `e`: Archive message
- `#` or `Delete`: Move message to Trash
- `s`: Toggle star / pin
- `u`: Toggle unread status
- `c`: Open new Outbound Compose modal
- `/`: Focus search input
- `d`: Toggle density (Comfortable / Compact)
- `?`: Open Keyboard Shortcuts overlay
- `Escape`: Close modal / clear selection

## 3. Anti-AI-Slop Guarantees
- Zero neon glows or decorative gradients.
- Solid surface panels ensuring readable text contrast (> 4.5:1 WCAG AA).
- No fake analytics or decorative sparklines.
- Strict functional hierarchy: Every visual element maps to real server state.
