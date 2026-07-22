# Takeoff Flow

Internal web app for the estimating/takeoff schedule. A static site (GitHub Pages)
backed by Supabase for sign-in, roles, and data — a more editable, Excel-like
companion to the Vendor Assignments Portal, based on the "FLOW OF TAKEOFFS" workbook.

## Features
- Email-code sign-in restricted to `@lennar.com`; roles: **admin / editor / purchasing / viewer**
- Division selector (Tampa, Orlando)
- Four tabs:
  - **Flow of Takeoffs** — editable grid; date columns auto-calculate from the
    trench date (business-day `WORKDAY` offsets) and are overridable per cell
  - **Pending Budgets** — mirrors the Flow rows; editors add per-person checkbox
    columns and bind each to a user email; that purchasing user ticks their column
  - **Takeoff Changes** — change-request log purchasing users can add lines to
  - **To-Do List** — auto-derived: upcoming trench dates + rows missing plans
- Import either the FLOW OF TAKEOFFS workbook (all rows/dates/notes) or the Start
  Schedule `.xlsx` (same file as the Vendor Portal; no RE2 needed) — auto-detected
- Ships with the 636 existing Orlando rows (`seed_orlando.sql` / `data/flow_orlando.js`)
- Every column header is sortable and filterable
- Per-tab CSV export, Print/PDF, light/dark theme, mobile layout
- Everything runs on free tiers (GitHub Pages + Supabase)

## Structure
- `index.html`, `styles.css`, `app.js` — the site
- `config.js` — Supabase URL + anon key, allowed domain, role seed, divisions, date rules
- `logo.svg` — brand logo / home button / favicon
- `supabase_setup.sql` — database schema + row-level-security (run once)
- `seed_orlando.sql` — bulk-load of the 636 existing Orlando rows into Supabase
- `data/flow_orlando.js` — same rows, embedded so the site shows them in demo mode
- `SETUP.md` — step-by-step setup and deploy guide

## Roles at a glance
| Role | Read | Import + edit Flow | Manage budget columns | Tick a budget column | Add Takeoff Changes | Manage users |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| viewer | ✓ | | | | | |
| purchasing | ✓ | | | only theirs | ✓ | |
| editor | ✓ | ✓ (their divisions) | ✓ | ✓ | ✓ | |
| admin | ✓ | ✓ (all) | ✓ | ✓ | ✓ | ✓ |

## Demo mode
Leave the `SUPABASE_*` placeholders in `config.js` and the site runs entirely in
the browser: any `@lennar.com` email + code `123456` signs you in as admin with
sample data. See `SETUP.md` to connect a real backend.

Division data lives in Supabase, not in this repo.
