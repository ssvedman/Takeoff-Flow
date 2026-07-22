/* ============================================================
   CONFIG — connect this file to your backend.
   These point at the SAME Supabase project as the Vendor Assignments Portal, so a
   single sign-in works across both sites (see SETUP.md). Blank/"YOUR_" = DEMO mode.
   ============================================================ */
window.APP_CONFIG = {
  // Shared with the Vendor Assignments Portal (Project Settings > API).
  SUPABASE_URL:  "https://memhzqphludiruovuzwt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lbWh6cXBobHVkaXJ1b3Z1end0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTI3MjUsImV4cCI6MjA5OTc4ODcyNX0.hTJBtb3WtkgY66xqzZ22GT7V4VNllxPyb4C7qXRFFVI",

  // Login is restricted to this email domain.
  ALLOWED_DOMAIN: "@lennar.com",

  // ---- Role tiers ----------------------------------------------------------
  // admin      : full access, all divisions, manage users, import, edit everything
  // editor     : import + edit the grids for the divisions listed; may add
  //              Pending-Budgets people-columns and bind each to a user email
  // purchasing : may ADD lines to Takeoff Changes, and tick the checkboxes in the
  //              Pending-Budgets column(s) that an editor assigned to their email
  // viewer     : read-only (everyone at @lennar.com not listed here)
  //
  // The authoritative roles live in the Supabase `app_roles` table (used by the
  // database security rules). This list is only a convenience seed / fallback so
  // the very first admin can sign in before the table is populated.
  ROLES: {
    "stephen.svedman@lennar.com": { role: "admin" }
    // "jane.doe@lennar.com":  { role: "editor",     divisions: ["tampa"] }
    // "buyer@lennar.com":     { role: "purchasing", divisions: ["orlando"] }
  },
  DEFAULT_ROLE: "viewer",

  // Divisions in the dropdown.
  DIVISIONS: [
    { key: "tampa",   label: "Tampa",   code: "TPU" },
    { key: "orlando", label: "Orlando", code: "OLH" }
  ],

  // ---- Date engine ---------------------------------------------------------
  // Mirrors the WORKDAY formulas from "FLOW OF TAKEOFFS". Each computed column is
  // derived from another column by an offset of business days (Mon–Fri, skipping
  // HOLIDAYS). "calendar:true" uses plain calendar days instead of business days.
  // Editors can still type a manual value on any cell to override the calc.
  DATE_RULES: {
    cis_due:       { from: "first_trench_date", days: -67 }, // CIS DUE          = WORKDAY(Trench,-67)
    master_tp_due: { from: "first_trench_date", days: -60 }, // MASTER TP LIST   = WORKDAY(Trench,-60)
    estimate_eta:  { from: "first_trench_date", days: -30 }, // ESTIMATE DONE    = WORKDAY(Trench,-30)
    pricing_stage: { from: "estimate_eta",      days:  2  }, // PRICING STAGE    = WORKDAY(Estimate,+2)
    tasks_start:   { from: "first_trench_date", days: -10 }, // TASKS START      = WORKDAY(Trench,-10)
    loc_upload:    { from: "tasks_start",       days: -5  }, // LOC UPLOAD       = WORKDAY(Tasks,-5)
    pricing_due:   { from: "first_trench_date", days: -30, calendar: true } // PENDING BUDGETS: Trench-30 cal days
  },
  // Optional company holidays excluded from business-day math, e.g. "2026-12-25".
  HOLIDAYS: [],

  // Default set of people-columns created on the Pending Budgets tab for a brand
  // new division. Editors can add/remove/rename these and bind each to an email.
  DEFAULT_BUDGET_COLUMNS: ["Jennifer", "Erik", "Grant", "Sandy", "Daysi", "Steve"],

  // Anti-abuse: per-browser limits on requesting a login code.
  // These apply once Supabase is connected; they're auto-bypassed in DEMO/test mode.
  OTP_LIMITS: { cooldownSec: 45, perHour: 5, perDay: 15 },

  // Demo verification code used only when Supabase is not configured.
  DEMO_CODE: "123456"
};
