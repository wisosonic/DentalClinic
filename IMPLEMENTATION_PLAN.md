# Dental Clinic — Dental Management System: Implementation Plan

Status: **phases 0–7 implemented** (see §13) · **Deployed from zero on a new server (owner decision 2026-10-07): nothing is imported or upgraded from the old app.** The sections below that talk about the dump, its import and the first 25 migrations are the history of how the schema was designed; the schema is now the single migration `001_initial_schema`, and a new installation runs `npm run db:setup`.

---

## 1. Goals & scope

A responsive web app (React + Node.js) for a dental clinic, used by **staff** (admin/doctor/assistant/receptionist) and **patients**.

| Feature | Staff | Patient |
|---|---|---|
| Schedule / manage appointments | full | book, view, cancel own |
| Patient records (incl. tooth chart) | full | view own |
| Quotations | full | view/accept own |
| Financial records (payments, expenses) | full | view own payments/balance |
| Labs, suppliers, medications | full | – |
| Treatment plans | full | view own |
| In-app notifications | yes | yes |
| Reports (PDF / Excel) | yes | own visit summary PDF |
| Secure login | yes | yes |

Out of scope for v1 (listed in §14): SMS/WhatsApp/email reminders, online payments, multi-tenant SaaS.

---

## 2. Findings from the existing schema (act on these first)

The database was designed in Laravel and exported from phpMyAdmin. Reading it turned up issues that shape the plan:

1. **Broken FK on import.** `appointment_tooth.tooth_id` references `tooths`, but the table is `teeth`. The dump will fail at that constraint. Fix in the migration (`REFERENCES teeth`).
2. **Money and dates are `varchar`.** `payments.ammount/remaining`, `quotes.cost/price`, `expenses.ammount`, `clinic_doctor.dr_part`, `categories.price_min/max`, and every `date`/`time` (`appointments.date`, `appointments.time`, `payments.date`, `expenses.date`, `report_tooth.date`, `patients.date_of_birth`, `patients.last_visit`). Sums, sorting, range filters and reports need real types. → migrate to `DECIMAL(12,2)` / `DATE` / `TIME` (§4.2). Note the column typo `ammount`; rename to `amount` in the API layer at minimum.
3. **Polymorphic-ish columns with no FK**: `payments.model_id` and `expenses.model_id` (+ `type`: `clinic`, `supplier`, …). Seed data shows `expenses.type='supplier'`, `model_id=2` → a supplier. Treat as `(type, model_id)` → supplier/lab reference; validate in the service layer.
4. **`role_user.role_id/user_id` are `int(11)`, not `bigint unsigned`, and have no FKs.** Also `users.role` (string) duplicates `role_user`. `roles.role` is an opaque permission string (`'FFFFFFFFFFFFFFFFFF'`, looks like a per-module permission bitmask/hex). Decide one model (§7.2).
5. **Patients → users link** (`patients.user_id`) is the hook for patient login. Only staff user (`id=1`, Aya Ghali, role `admin`) is seeded; patients have `user_id = NULL`, so patient accounts must be provisioned (§7.3).
6. **Laravel infrastructure tables are dead weight** for Node: `cache`, `cache_locks`, `jobs`, `job_batches`, `failed_jobs`, `migrations`, `sessions`, `password_resets` (legacy duplicate of `password_reset_tokens`), `personal_access_tokens`. Keep them untouched initially (harmless), drop later once cut over.
7. **Existing bcrypt hash uses `$2y$` prefix** (PHP). `bcryptjs`/`bcrypt` for Node verify `$2y$` fine, so the admin can log in with the current password; no forced reset needed. Enforce rehash-on-login if cost < 12.
8. **The SQL dump contains a live `remember_token` and password hash** for the admin. Rotate the admin password after first login, and don't commit the dump to a public repo.
9. **Reference tables `teeth`, `categories`** drive the tooth chart and procedure pricing. `categories.features` / `feature_prices` are JSON stored as `longtext` — keep as JSON and validate shape in the API.
10. Tables present in schema but **not named in the feature list**: `clinics`, `clinic_doctor` (per-clinic doctor share `dr_part` + schedule string), `events`/`event_patient`/`promotions` (marketing campaigns, quotes can link to an event), `numbering` + `settings` (waiting-room numbering toggle), `notifications` (per `user_id`). Plan supports them as secondary modules (Phase 7).

---

## 3. Architecture

```
┌───────────────┐   HTTPS / JSON    ┌────────────────────────┐    ┌──────────────┐
│ React SPA     │ ────────────────▶ │ Node.js / Express API  │ ─▶ │ MariaDB      │
│ (Vite, TS)    │ ◀──── SSE ─────── │  - auth, RBAC          │    │ aya_clinic   │
│ Redux Toolkit │   notifications   │  - services / repos    │    └──────────────┘
│ + RTK Query   │                   │  - report generators   │    ┌──────────────┐
└───────────────┘                   │  - node-cron scheduler │ ─▶ │ Redis (opt.) │
                                    └────────────────────────┘    └──────────────┘
```

- **Modular monolith.** One API process with feature modules; no microservices (clinic scale).
- **Layers per module:** `routes → controller (HTTP) → service (business rules) → repository (Knex)`. Validation at the route boundary, authorization in middleware, business invariants in services.
- **Same-origin deployment:** API served under `/api`, SPA static files behind the same reverse proxy (nginx/Caddy) → simpler cookies/CORS/CSP.
- **Real-time notifications:** Server-Sent Events (one-way, simple, works through proxies) backed by the `notifications` table; fall back to polling every 60 s. Socket.IO is unnecessary.
- **Scheduler:** `node-cron` job runs every 15 min, creates reminder notifications for appointments in the next 24 h / 2 h (idempotent, see §9).

---

## 4. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript | typed API contracts shared with the frontend |
| API | Express 5 | mature, minimal |
| DB | **SQLite for development**, MariaDB/MySQL later | no server to install; switch with `DB_CLIENT=mysql` (same migrations, `mysql2` already installed). Production should use MariaDB/MySQL |
| Query builder / migrations | **Knex** (decided over Prisma) | one migration set runs on SQLite and MySQL; Prisma fixes the database type in its schema file, which would make the later switch awkward |
| Validation | Zod (shared schemas in `packages/shared`) | one schema for API + forms |
| Auth | `bcrypt`, `jsonwebtoken`, httpOnly cookies | see §7 |
| Security middleware | `helmet`, `cors` (locked origin), `express-rate-limit`, own double-submit CSRF middleware (`hpp` dropped: it conflicts with Express 5's read-only `req.query`; Zod validation rejects array-valued params instead) | |
| Logging | `pino` + `pino-http` | structured, redacts secrets |
| Reports | `pdfkit` (PDF), `exceljs` (xlsx) | no headless browser needed |
| Scheduler | `node-cron` | |
| Tests | Vitest + Supertest (API), React Testing Library, Playwright (e2e) | |
| Frontend | React 18 + Vite + TypeScript | |
| State | **Redux Toolkit + RTK Query** | caching, invalidation, auth slice; Context only for theme/i18n |
| UI | MUI (or Tailwind + Radix) | responsive grid, accessible components, data tables |
| Forms | React Hook Form + Zod resolver | |
| Calendar | FullCalendar (day/week/month, resource view per doctor) | |
| Charts | Recharts | dashboard |
| Routing | React Router 6 | |
| i18n | `react-i18next` (en/fr/ar with RTL) | names/phones suggest Lebanon; confirm languages |
| Lint/format | ESLint + Prettier, Husky pre-commit | |
| CI | GitHub Actions: lint, typecheck, test, build | |

### 4.1 Repository layout (monorepo, npm workspaces)

```
DentalClinic/
├─ apps/
│  ├─ api/
│  │  ├─ scripts/ (migrate, setup, set-password)
│  │  └─ src/ (db/ holds connection, migrations/, setup.ts)
│  │     ├─ app.ts, server.ts, config/env.ts
│  │     ├─ middleware/ (auth, rbac, validate, error, rateLimit, audit)
│  │     ├─ modules/
│  │     │   auth, users, patients, doctors, clinics, appointments,
│  │     │   visits(reports), teeth, categories, quotes, payments, expenses,
│  │     │   labs, suppliers, medications, events, promotions,
│  │     │   notifications, reports-export, settings, dashboard
│  │     ├─ jobs/ (reminders.ts)
│  │     └─ lib/ (pdf.ts, excel.ts, money.ts, logger.ts)
│  └─ web/
│     └─ src/ (app/, features/<module>/, components/, routes/, i18n/)
└─ packages/shared/ (zod schemas, enums, types)
```

### 4.2 Schema migration strategy (as implemented)

Rather than altering an imported MariaDB schema in place, the typed schema is defined as Knex migrations and the dump's *data* is imported into it. The dump file is never edited.

1. `001_baseline` — the domain schema with the fixes applied: money `DECIMAL(12,2)`, `DATE` columns, `ammount` → `amount`, `appointment_tooth` → `teeth` (the dump pointed at `tooths`), RESTRICT foreign keys and `deleted_at` on patients/quotes/payments, `users` gains `is_active`, `failed_logins`, `locked_until`, `last_login_at`, `notifications` gains `type`, `link`, `read_at`, `dedupe_key`, `appointment_id`. The Laravel infrastructure tables (cache, jobs, sessions, personal_access_tokens, password_resets, ...) are **not** recreated.
2. `002_auth` — `refresh_tokens`, `password_reset_tokens` (hashed), `audit_log`.
3. `003_plans_and_labs` — `treatment_plans`, `treatment_plan_items`, `lab_orders`.
4. `importDump.ts` — parses the dump's `INSERT` statements, converts values, aborts before writing anything if a value cannot be parsed, then verifies row counts and per-column money totals (in integer cents) against the source. `npm run db:import`.

Not done: the double-booking unique index. MySQL has no partial indexes, so it is enforced in the appointment service (transaction + overlap check) in phase 3, with a plain index for lookups.

**New / changed tables**

| Table | Purpose | Key columns |
|---|---|---|
| `treatment_plans` | Track treatment plans (no table exists today — `quotes` + `appointment_category` only approximate it) | `id, patient_id, doctor_id, title, status(draft/proposed/accepted/in_progress/completed/cancelled), quote_id?, start_date, notes` |
| `treatment_plan_items` | Steps of a plan | `id, plan_id, tooth_id?, category_id, description, est_price DECIMAL, sequence, status(pending/scheduled/done), appointment_id?, completed_at` |
| `lab_orders` | Manage labs (only `labs` directory exists) | `id, lab_id, patient_id, appointment_id?, item, tooth_id?, cost DECIMAL, sent_at, due_at, received_at, status` |
| `audit_log` | Who changed/viewed what | `id, user_id, action, entity, entity_id, diff JSON, ip, at` |
| `refresh_tokens` | Rotating refresh tokens (hashed) | `id, user_id, family_id, token_hash, remember, expires_at, revoked_at, replaced_by, user_agent, ip` |
| `notifications` (alter) | Add `type`, `link`, `read_at`, `dedupe_key UNIQUE`, `appointment_id?` | dedupe makes the reminder job idempotent |
| `users` (alter) | Add `is_active`, `failed_logins`, `locked_until`, `last_login_at`; make `role` an enum |  |

Model summary (existing tables, relationships):

```
users 1─* patients(user_id)      doctors 1─* patients(doctor_id)
patients 1─* appointments ─* (appointment_category → categories)
appointments ─* (appointment_tooth → teeth)      appointments 1─* reports 1─* report_tooth / medication_report → medications
appointments *─1 quotes (quote_id) ; quotes 1─* payments ; quotes *─1 patients ; quotes *─1 events ─1 promotions
clinics ─* clinic_doctor *─ doctors (dr_part = doctor's % share; kind owner|external, commission_percent)
clinics ─* dental_units *─ owner doctor ; appointments *─1 dental_units
expenses(type, model_id → supplier/lab) , user_id → users
```

---

## 5. REST API

Base `/api/v1`. JSON. Auth via cookie (§7). Lists support `?page&pageSize&sort&q&from&to` and return `{ data, meta:{page,pageSize,total} }`. Errors: `{ error:{ code, message, details? } }` with correct HTTP status.

Roles: **A**=admin, **D**=doctor, **S**=staff (assistant/reception), **P**=patient (own data only).

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | email+password → sets access + refresh cookies; rate-limited, lockout |
| POST | `/auth/refresh` | rotates refresh token |
| POST | `/auth/logout` | revokes refresh token |
| GET | `/auth/me` | current user + role + permissions + patient/doctor id |
| POST | `/auth/reset-password` | uses `password_reset_tokens` (store **hash** of token); links are made by an admin with `POST /users/:id/reset-link` (24 h); there is no public forgot-password route because the clinic sends no email |
| POST | `/auth/change-password` | required when `users.change_password = '1'` |
| POST | `/auth/register-patient` | optional self-registration via invite/verification (§7.3) |

### Patients — `/patients` (A,D,S full; P: `GET /patients/me`)
`GET /` · `POST /` · `GET /:id` · `PATCH /:id` · `DELETE /:id` (A only, soft-delete preferred) · `GET /:id/appointments` · `GET /:id/quotes` · `GET /:id/payments` · `GET /:id/treatment-plans` · `GET /:id/chart` (teeth history from `report_tooth`) · `POST /:id/account` (create/invite patient login).
`patient_identifier` generated server-side (unique; existing values are 6-digit numbers).

### Appointments — `/appointments`
`GET /` (filters: doctor, clinic, status, date range, patient) · `POST /` · `GET /:id` · `PATCH /:id` · `POST /:id/confirm|cancel|complete|no-show` · `GET /busy?doctorId&unitId&date` (what is already booked for that doctor and unit; there is no schedule) · `PUT /:id/categories` · `PUT /:id/teeth`.
Patients: `POST /appointments` (creates `pending`), `POST /:id/cancel` (own, up to N hours before).

### Visits / clinical reports — `/appointments/:id/report`
`GET` · `PUT` (summary) · `PUT /teeth` (`report_tooth` rows with surfaces labial/buccal/lingual/mesial/distal/occlusal) · `PUT /medications` (prescriptions, `medication_report`) · `GET /pdf` (visit summary / prescription PDF).

### Reference data
`/teeth` (read-only) · `/categories` (CRUD; A) · `/medications` (CRUD; A,D) · `/doctors` (CRUD; A) · `/clinics` (CRUD; A) · `/clinics/:id/doctors` (assign a doctor: share %; assigning an owner creates their dental unit) · `/units` (list, rename, delete).

### Quotations — `/quotes` (A,D,S; P own read + accept)
`GET/POST/PATCH/DELETE` · `POST /:id/send` (notify patient) · `POST /:id/accept` · `GET /:id/pdf` · `POST /:id/convert-to-plan`. Status: `draft → sent → accepted → paid | partially_paid | rejected | expired` (seed uses `paid`; keep existing values valid).

### Financial — `/payments`, `/expenses`
`payments`: CRUD, `GET ?quoteId&from&to&type`, server recomputes `remaining` from quote price − sum(payments) (never trust client), `dr_part` computed from `clinic_doctor.dr_part`.
`expenses`: CRUD, filter by type/supplier/date.
`GET /finance/summary?from&to` → income, expenses, net, doctor share, outstanding balances, by month.

### Labs & suppliers — `/labs`, `/lab-orders`, `/suppliers`
CRUD each; `lab-orders` status flow `draft → sent → received → fitted`; overdue listing; linking cost to an expense.

### Treatment plans — `/treatment-plans`
CRUD · `POST /:id/items` · `PATCH /:id/items/:itemId` · `POST /:id/items/:itemId/schedule` (creates appointment) · `POST /:id/accept` · progress = done items / total.

### Events & promotions — `/events`, `/promotions`, `/events/:id/patients`
CRUD (A). `POST /promotions/validate {code}` for discount on quotes.

### Notifications
`GET /notifications?status=unread` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` · `GET /notifications/stream` (SSE).

### Reports / exports — `/reports`
| Endpoint | Formats |
|---|---|
| `GET /reports/daily-schedule?date` | PDF |
| `GET /reports/appointments?from&to&doctorId&status` | xlsx, pdf |
| `GET /reports/revenue?from&to&groupBy=day|month` | xlsx, pdf |
| `GET /reports/expenses?from&to&type` | xlsx, pdf |
| `GET /reports/outstanding-balances` | xlsx, pdf |
| `GET /reports/patients?from&to` (new patients, retention) | xlsx |
| `GET /reports/procedures` (by category counts/revenue) | xlsx, pdf |
| `GET /reports/lab-orders` | xlsx |
Param `format=pdf|xlsx`. Large ranges streamed, not buffered.

### Users & settings (A)
`/users` CRUD + activate/deactivate + reset password · `/roles` · `/settings` (`ENABLE_PATIENT_NUMBERING`, reminder lead times, slot length, clinic info) · `/numbering` (waiting-room counter: `POST /next`, `POST /reset`) · `/audit-log`.

---

## 6. Frontend

### 6.1 Route map

```
/login  /forgot-password  /reset-password/:token
STAFF  (layout: sidebar + topbar + bell)
  /                       Dashboard
  /calendar               Appointment calendar (day/week/month, per doctor)
  /appointments           List + filters ; /appointments/new ; /appointments/:id
  /patients               List ; /patients/new ; /patients/:id (tabs below)
      tabs: Overview · Appointments · Dental chart · Treatment plans · Quotes · Payments · Files/Notes
  /treatment-plans ; /treatment-plans/:id
  /quotes ; /quotes/:id
  /finance                Payments · Expenses · Summary
  /labs  (Directory · Orders)      /suppliers
  /medications
  /reports                Report builder + download
  /events  /promotions
  /settings  (Users, Roles, Clinics & doctors, Categories, General)
PATIENT  (simplified layout, bottom nav on mobile)
  /me                     Upcoming appointments + balance
  /me/book                Book appointment (doctor → date → slot → confirm)
  /me/appointments  /me/plans  /me/quotes  /me/payments  /me/profile
```

### 6.2 Key components

- **Shell:** `AppLayout`, `Sidebar` (collapses to drawer < 900 px), `TopBar`, `NotificationBell` (unread badge, dropdown, SSE subscription), `ProtectedRoute`/`RoleGate`.
- **Generic:** `DataTable` (server pagination/sort, column toggle; becomes card list on mobile), `FilterBar`, `ConfirmDialog`, `FormField` wrappers, `MoneyInput`/`MoneyText` (decimal-safe), `DateRangePicker`, `StatusChip`, `EmptyState`, `ErrorBoundary`, `Skeletons`.
- **Appointments:** `AppointmentCalendar`, `AppointmentForm` (patient autocomplete, doctor/clinic, slot picker from `/availability`, procedure categories, teeth picker), `SlotPicker`, `AppointmentStatusMenu`.
- **Clinical:** `ToothChart` (SVG odontogram, FDI numbering from `teeth.index`, click tooth → `ToothSurfaceEditor` for the 6 surfaces), `VisitReportForm`, `PrescriptionEditor` (medication, dose, frequency, time_unit, notes).
- **Plans/quotes:** `TreatmentPlanBuilder` (drag-order items, price from `categories` + features), `QuoteEditor` (line items, discount code, currency), `QuotePDFPreview`.
- **Finance:** `PaymentForm` (quote picker shows remaining), `ExpenseForm`, `FinanceSummaryCards`, `RevenueChart`.
- **Reports:** `ReportPicker` (type, range, doctor, format) → download with progress.
- **Patient portal:** `UpcomingCard`, `BookingWizard`, `BalanceCard`.

### 6.3 State management

- Redux Toolkit store: `auth` slice (user, role, permissions), `ui` slice (sidebar, filters persisted per page), RTK Query API slice per module with tag invalidation (e.g. creating a payment invalidates `Quote`, `Finance`).
- No tokens in JS-accessible storage (cookies are httpOnly). CSRF token read from a non-httpOnly cookie/endpoint and sent as header.
- Notifications: SSE → dispatch into RTK cache (`notificationsApi.util.updateQueryData`).
- Route-level code splitting (`React.lazy`) — calendar, charts, and PDF preview are separate chunks.

### 6.4 UX / responsiveness

- Mobile-first breakpoints (600/900/1200). Tables → cards under 600 px; calendar defaults to day/list view on phones; forms single column; 44 px touch targets.
- Patient portal is the primary mobile experience (booking in ≤ 4 taps); ensure installable PWA (manifest + offline shell) — optional.
- Accessibility: WCAG 2.1 AA, keyboard navigable calendar/tooth chart, aria-live for notifications, color not sole status indicator.
- i18n with RTL support if Arabic is required; dates/currency formatted with `Intl`.
- Loading skeletons, optimistic updates for status changes, undo toast for cancels, unsaved-changes guard on long forms.

---

## 7. Authentication & authorization

### 7.1 Flow
- Login: email + password (bcrypt, cost 12). Response sets:
  - `access_token` — JWT, 15 min, `httpOnly; Secure; SameSite=Lax`, path `/api`.
  - `refresh_token` — opaque random 256-bit, 7 days (30 with "remember me"), `httpOnly; Secure; SameSite=Strict`, path `/api/auth`; only its SHA-256 is stored in `refresh_tokens`; **rotated on every use**, reuse of a revoked token revokes the whole family.
- Brute-force: 5 failed logins → 15 min lock (`locked_until`) + IP rate limit (10/min). Generic error message ("invalid credentials"); constant-time comparison; dummy hash when user not found to equalize timing.
- Password policy: ≥ 10 chars, checked against a breached/common list (zxcvbn); `change_password='1'` forces change on next login (existing field).
- Optional (phase 8): TOTP 2FA for admin/doctor.

### 7.2 RBAC
- Collapse to **one** source of truth: `users.role ∈ {admin, doctor, staff, patient}` and a static permission map in code (`modules × {read,create,update,delete}`). Migrate `roles`/`role_user` to this (keep tables until cutover; decode `roles.role` hex string if it encodes per-module flags — **ask the owner** what `FFFFFFFFFFFFFFFFFF` means before discarding).
- Middleware `requireRole(...)` / `requirePermission('quotes:update')` on every route; deny by default.
- **Object-level checks** (prevent IDOR): patients can only touch rows where `patient.user_id = req.user.id`; doctors limited to own patients/appointments unless admin (configurable: clinic-wide visibility for small clinics).

### 7.3 Patient accounts
- Staff click "Invite to portal" on a patient → creates `users` row (`role='patient'`, `change_password='1'`, random temp password or emailed one-time set-password link) and sets `patients.user_id`. Matching by phone/email/`patient_identifier` + DOB for optional self-registration, with email verification (`email_verified_at`).
- Patients see a strict subset of fields (no internal notes `patients.description`, no cost/`dr_part` figures).

---

## 8. Business rules (enforced in services + DB)

- **No double booking:** one transaction checks that neither the doctor nor the dental unit has an overlapping appointment (`SELECT … FOR UPDATE` on both on MySQL). Appointments have their own length (`duration_minutes`). There are no working hours.
- Status machine: `pending → confirmed → completed | cancelled | no_show`; no edits to completed visits except by admin (audited).
- `quotes.status` and `remaining` are derived from payments; recalculated in the same transaction as every payment write. Overpayment rejected.
- Doctor share: `payments.dr_part = amount × clinic_doctor.dr_part%` (seed has `'100'` → 100%; confirm whether field is % or amount).
- Currency: store per-row currency (seed uses `$`); reports group by currency — never sum across currencies. Decide if an exchange rate is needed (Lebanon: USD/LBP likely).
- Deleting patients cascades everything today (`ON DELETE CASCADE` everywhere, including financial rows). Change financial FKs to `RESTRICT` and use **soft delete** (`deleted_at`) for patients/quotes/payments.
- `patients.last_visit` updated when an appointment is completed.

---

## 9. Notifications

1. **Generation** (`jobs/reminders.ts`, every 15 min): select `confirmed` appointments starting in (24 h ± window) and (2 h ± window) → insert into `notifications` with `dedupe_key = "appt:{id}:24h"` (unique → safe to re-run) for patient's user and the doctor's user.
2. **Event-driven** notifications on: new booking (to staff), cancellation, quote sent/accepted, payment received, lab order overdue, plan item due.
3. **Delivery:** SSE stream per logged-in user (heartbeat 25 s, auto-reconnect with `Last-Event-ID`); unread badge from `GET /notifications?status=unread`; mark-read endpoints. Content is text only — sanitize/escape on render.
4. Patients without portal accounts: leave a hook (`NotificationChannel` interface) to add SMS/WhatsApp/email later without touching the generator.
5. If running multiple API instances, move the cron to a single worker (or use a DB advisory lock) and fan out SSE via Redis pub/sub.

---

## 10. Reports

- **Excel (`exceljs`)** for tabular/analytic: appointments, revenue, expenses, outstanding balances, procedures, lab orders. Frozen header, typed cells (dates/currency), totals row with formulas, one sheet per currency.
- **PDF (`pdfkit`)** for documents people hand out or sign: quotation, payment receipt, visit summary/prescription, daily schedule, finance summary (with charts rendered as simple vector bars). Clinic letterhead from `clinics`/`settings`; Unicode fonts embedded (Arabic shaping needs a font + bidi handling — test early if Arabic is required).
- Generated on demand, streamed; heavy ranges (> 50k rows) run as a background job with a download link in notifications.
- All report routes are permission-gated and audited (they export PHI/finance data).

---

## 11. Security checklist

| Area | Measures |
|---|---|
| Transport | HTTPS only, HSTS, secure cookies |
| Passwords | bcrypt cost ≥ 12, policy + breached-password check, rehash on login |
| Sessions | short-lived JWT + rotating refresh, revocation, logout-everywhere |
| Input | Zod validation on body/query/params, strict types (no mass assignment — whitelist fields), max body 1 MB, file uploads (if added) type/size-checked |
| SQL injection | Knex parameterized queries only; no raw SQL with string concat (raw queries use tagged templates) |
| XSS | React escaping, no `dangerouslySetInnerHTML`; strict CSP via helmet (no inline scripts); sanitize rich-text notes if ever enabled |
| CSRF | `SameSite` cookies + double-submit token header on state-changing requests |
| CORS | single allowed origin, credentials on |
| IDOR / BOLA | object-level ownership checks (§7.2), tests per route |
| Rate limiting | global + stricter on `/auth/*`, `/reports/*` |
| Secrets | `.env` validated at boot (Zod), never logged, separate per environment, JWT secret ≥ 256 bit |
| Data protection | DB user least-privilege (no DDL at runtime), encrypted backups, optionally encrypt sensitive free-text columns; log redaction (passwords, tokens, phone) |
| Audit | `audit_log` for create/update/delete on clinical & financial entities, and exports |
| Dependencies | `npm audit` in CI, Dependabot, lockfile committed |
| Errors | no stack traces to clients; central error handler; consistent 401/403/404 (don't leak existence) |
| Privacy | health data is sensitive → data-retention policy, patient data export/delete process; check local regulation (GDPR-like/HIPAA if applicable) |
| Hygiene | the first administrator gets a random temporary password from `db:setup` and must change it at first sign-in (the old dump is gone) |

---

## 12. Performance

- Indexes (§4.2) on all filter/sort columns: appointment `(doctor_id, date, time)`, `(patient_id, date)`; payments `(quote_id)`, `(date)`; patients `(lname, fname)`, `phone`, FULLTEXT for search.
- Cursor/offset pagination everywhere; never return unbounded lists. Avoid N+1 by joining or batching queries and selecting only needed columns.
- Dashboard aggregates via SQL `GROUP BY` (not JS loops), cached 60 s in memory (Redis if scaled).
- gzip/brotli at proxy, `ETag`s on reference data (`teeth`, `categories`), HTTP caching headers for static assets (hashed filenames).
- Frontend: code splitting, virtualized long lists, debounce search (300 ms), RTK Query cache lifetimes, image/font optimization; Lighthouse budget ≥ 90 on mobile for the patient portal.
- SSE connection per user is cheap; cap at 1 per tab and close when tab hidden.
- Connection pool sized to DB limits; slow-query log on.

---

## 13. Delivery phases

| # | Phase | Deliverables | Exit criteria |
|---|---|---|---|
| 0 | **Foundation** (≈ 1 wk) | Monorepo, TS, env validation, SQLite import of the dump with the `tooths` fix. *(Lint/CI and Docker Compose not done yet; Docker is not needed while on SQLite.)* | `npm run dev` brings up everything; CI green |
| 1 | **Schema hardening** (≈ 1 wk) | Migrations 0002–0004 (types, constraints, new tables), data verification script (row counts, money sums before/after) | Totals identical pre/post migration |
| 2 | **Auth & RBAC** (≈ 1 wk) | Login/refresh/logout/reset, lockout, RBAC middleware, audit log, login UI, protected routes | Security tests pass (IDOR, brute force) |
| 3 | **Core clinical** (≈ 2 wks) | Patients, doctors/clinics, appointments + availability + calendar UI | Book/reschedule/cancel with no double booking |
| 4 | **Visit records** (≈ 1.5 wks) | Visit reports, tooth chart, prescriptions, medications CRUD | Doctor can complete a visit end-to-end |
| 5 | **Money** (≈ 2 wks) | Quotes, payments, expenses, finance summary, quote/receipt PDFs | Balances reconcile with seed data |
| 6 | **Plans, labs** (≈ 1.5 wks) | Treatment plans, lab orders, suppliers | Plan → scheduled appointments → completion |
| 7 | **Notifications & reports** (≈ 1.5 wks) | Reminder job, SSE, bell UI, Excel/PDF reports | Reminders fire once, exports open correctly |
| 8 | **Patient portal** (≈ 1.5 wks) | Invite flow, booking wizard, own data views, mobile polish | Patient books from phone in ≤ 4 taps |
| 9 | **Secondary modules** (≈ 1 wk) | Events/promotions, numbering/settings | |
| 10 | **Hardening & launch** (≈ 1.5 wks) | Pen-test checklist, load test, backups/restore drill, e2e suite, docs, deploy | Go-live checklist signed off |

### Progress

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | ✅ done (minus lint/CI/Docker) | npm workspaces, `apps/api`, `apps/web`, `packages/shared` |
| 1 Schema hardening | ✅ done | 3 migrations + verified dump import (all rows, all money totals match, all FKs valid) |
| 2 Auth & RBAC | ✅ done | login, refresh rotation with reuse detection, lockout, forced change, reset, CSRF, rate limits, RBAC matrix, ownership guard, audit log, `/users` admin API, login/reset/change-password UI. 72 API + 11 web tests |
| 3 Core clinical | ✅ done, reworked 2026-10-01 | patients (search, duplicates, soft delete, ownership), doctors (owner or external, commission percentage), clinics, dental units, appointments (variable length, doctor and unit overlap checks, no working hours, reschedule, status machine, staff-only booking, patient cancel), calendar, a by-unit day view (one column per dental unit) and list UI with a unit filter, doctors & clinics admin UI including adding dental units. Migrations 004 and 005 verified on a copy of the real data |
| 4 Visit records | ✅ done | one optional report per appointment (summary, per-tooth notes, prescriptions) with the access rules the owner chose; patient timeline (summary and prescriptions only) and staff timeline; dental chart history; patient-safe visit PDF; medications and procedures management; doctor profile linked to a login (`doctors.user_id`); odontogram, report editor, timeline and chart UI. Migration 006 |
| Between 4 and 5 | ✅ done | **External specialist sign-in** (`lib/scope.ts`: own patients in full; another doctor's patient only as appointment + report) with API and screen tests; **Arabic interface with right-to-left layout** (react-i18next, English text as the key so anything untranslated shows English, language switch remembered per browser, Arabic calendar with Western digits, dental chart kept left to right, server and validation messages translated, dictionary completeness tests) |
| Branding and restyle | ✅ done | app logo in header and sign-in; separate **Doctors** and **Clinics** pages; clinic logo upload (migration 007, `UPLOAD_DIR`); refreshed Material theme (brand teal/petrol, softer surfaces, navigation highlight) |
| Breadcrumbs | ✅ done | `AppBreadcrumbs` above every page: Dashboard > section > (patient name), linked, current page marked, RTL-aware |
| Grouped side menu | ✅ done | pages grouped under coloured, collapsible headers (Clinic, Finance, Catalog, Administration); folded state remembered; current page's group opens itself; empty groups hidden by role; accessible (aria-expanded), right-to-left aware; tests |
| Passwords without email | ✅ done | public forgot-password route and mail sending removed; admin **reset link** (one-time, 24 h, hashed) and temporary password; new admin **Users** page (create accounts incl. doctor logins, reset link, temporary password, switch on/off, sortable); sign-in help page tells people to ask the clinic; API and screen tests |
| Access logging | ✅ done | `auditView` records who opened a patient's profile, timeline, chart, appointments, an appointment or its report (under the patient, ids only, de-duplicated per 10 minutes, patients' own views skipped); audit API with filters, names and sorting; admin **Activity log** page and a "Who viewed this record" shortcut on the patient page; API and screen tests |
| Trash and permanent delete | ✅ done | staff and doctors soft delete patients, appointments and reports (migration 008: `deleted_at`, `deleted_by`); admin-only **Trash** page with restore (double-booking check, parent-first rules) and **erase for good** (impact counts, typed patient name, one transaction, attached records erased, audit entry with counts only); deleted items vanish from lists, calendar, timeline, chart and PDFs; API and screen tests |
| 5 Money, part one: quotes and payments | ✅ done | migration 009 (payment method, collector snapshot, created-by, soft-delete owners; balances recomputed, checked against the imported data: 78 payments, $5,485); quotes (hand-set statuses, derived paid and partly paid), payments (overpayment refused, running balance), doctor/admin/staff rules as the owner set them, staff narrow entry, Quotes and Payments pages, Trash support; API (466) and screen tests |
| 5 Money, part two: expenses and commission | ✅ done | migration 010 (expense soft delete and visit link; old `general` expenses are now `clinic`); five expense types with the lab, supplier or specialist and visit they name, personal ones admin-only; commission statement (owner of the unit of the latest completed visit, percentage of what the specialist collected, less what he paid over, missing percentages reported); commission payments; fees paid to specialists; Expenses and Commission pages; Trash support; API (489) and screen tests |
| 5 Money, part three: Summary | ✅ done | admin-only `GET /finance/summary` and Summary page: period filter with shortcuts, total payments (from patients plus commission received, listed by type) and total expenses with browse buttons, net profit, patients' total debts with the biggest debtors and a browse button; quotes can be filtered to those with a balance; API (499) and screen tests |
| 5 Money, part four: quote and receipt PDFs | ✅ done | pdfkit documents with the clinic letterhead; the quote never shows the clinic cost; receipts show the balance after; same access rules as the records; audited and counted as views; buttons on the quote and every payment; API (510) and screen tests |
| 5 Money, part five: chart and per-doctor figures | ✅ done | `byMonth` on the summary and a hand-built, colour-checked monthly chart (tooltip, keyboard, table view); `GET /finance/doctors` and the **By doctor** page (admin all, a doctor himself); a new patient must have a primary doctor; API (520) and screen tests. **Phase 5 is complete** apart from `convert-to-plan`, which goes with phase 6 |
| Sortable tables | ✅ done | all data columns sortable in patients, appointments (including a **Report** column: written or not) (server-side, whitelisted columns, stable ties), doctors, medications, procedures (browser-side); `SortCell`/`useSort`/`sortRows` helpers; API and screen tests |
| 4b Dental panorama | ✅ done | one flat illustration of all 32 teeth drawn in code (no image file, no licence), tooth outlines and click areas from one layout so they always match; patient history drawn over it (highlighted, clickable to read); report editor and appointment teeth dialog select teeth on it; replaces the old tooth chart; zone-map and component tests. |
| 6 Plans and labs | ✅ done | migration 011 (soft delete for plans and lab orders); treatment plans (`/treatment-plans`: items kept in order, propose/accept/cancel, book an item through `assertBookable`, mark done, plan follows its visits, draft quote from an accepted plan; visible like quotes, staff read and book only); lab orders (`/lab-orders`: staff and admin write, doctors read their own patients' orders without cost, send/receive/fit, overdue, filters); labs and suppliers CRUD (`/labs`, `/suppliers`, refuse delete when used); Trash kinds `plan` and `lab_order`; pages Treatment plans (list and detail with builder), Lab orders, Labs, Suppliers; links on the patient page; Arabic, toasts and activity-log labels; API (554+) and screen tests |
| Tidy-up after phase 6 | ✅ done | Summary breaks expenses down by lab and by supplier and downloads as CSV; web bundle split into vendor chunks (react, mui, redux, i18n; no size warning); ESLint set up and clean; GitHub Actions CI workflow |
| Dashboard insights | ✅ done | `GET /dashboard/charts` shaped by role (admin: clinic money and activity; doctor: own patients, no expenses; staff: week ahead, overdue lab orders, plans awaiting acceptance, no money), `InsightsSection` on the dashboard with the month chart, ranked bars and empty/error states; monthly figures shared with the Summary (`finance/months.ts`); API (13) and screen (8) tests |
| Lebanese income tax | ✅ done | shared `calculateIncomeTax` (USD converted plus LBP payments added as they are, tax percentage, family allowances, progressive brackets, LBP only); rules saved by year (migration 013 `tax_rule_sets`: the estimate for a year uses the latest set starting in or before it; starting values until saved); doctors' spouse and children on their profile (admin only); Settings page (rate, percentage, allowances, brackets, sets by year) and Income tax page (year, taxpayer, family details, what-if amount, step-by-step and bracket table); `GET /finance/tax`, `GET/PUT/DELETE /settings/tax`; hand-worked API and screen tests |
| Tax year declared and paid | ✅ done | migration 014 `tax_declarations`; "Mark this year as declared and paid" stores the day's figures (payments, family details, rules, result) per year and taxpayer; a declared year is served from the stored copy and never recalculated, with the page locked and a warning if the payments moved since; API and screen tests |
| Settings: General and Appearance | ✅ done | migration 015 `app_settings`; General (default language, timezone that drives all date calculations, clinic contact details on the PDF letterheads) and Appearance (light/dark mode, text size); `GET /public-settings` for the pre-login look; dark theme with its own validated chart colours; API and screen tests |
| 7 Notifications and reports | ✅ done | in-app notifications (reminder 2 h before a confirmed appointment to the treating doctor and staff; events: booking, cancellation, quote sent/accepted, payment, overdue lab order, plan accepted; switches in Settings > General), node-cron jobs every 15 min, Server-Sent Events with polling fallback, bell with unread badge; reports: daily schedule (PDF), revenue and expenses and outstanding balances (Excel, PDF), appointments, procedures, new patients, lab orders (Excel), each limited like the screens and audit-logged; API (652) and screen (338) tests |
| Phase 7 follow-ups | ✅ done | a notification for a no-show (an overdue-commission and a plan-visit-to-book notification were built, then removed on 2026-10-06 by the owner); Excel reports of 50,000 to 500,000 rows made in the background (migration 019 `report_jobs`, streamed Excel file, notification when ready, *Big reports* list with download, 7-day keep, cleanup); API and screen tests. Patient reminders wait for phase 8 |
| Roles and permissions | ✅ done | Administration > Roles: the admin switches what doctor and staff may do (migration 018 `role_permissions`, differences from the built-in table only); admin, patient and system modules locked; money and supplier access revocable but not grantable; `permissions` in `/auth/me` and a menu that hides what a role may not open; audited; API and screen tests |
| Deleting a clinic keeps its data | ✅ done | migration 017 (appointments and dental units keep their rows with no clinic; SQLite tables rebuilt safely); read-only records (`CLINIC_DELETED`); admin page "Deleted clinics' data" to review and delete them; money, commission and tax figures unchanged; API and screen tests |
| Patient documents | ✅ done | see 13.1: x-ray, panoramic, CBCT report, blood analysis; images and PDF, 25 MB; staff, doctors, admin; stored under `UPLOAD_DIR`; Trash and audit |
| Treatment offers (plans and quotes merged) | ✅ done | migration 020 (every quote became an offer with one finished item, plans merged in, totals checked on a copy of the real data: 70 offers, $7,850 and 78 payments, $5,485 unchanged); `/treatment-offers` API with items, three indicators (status, payment, work), booking, PDF; payments, commission, summary, tax, dashboard, reports, notifications, Trash and the dump import follow; Treatment offers list and detail pages replace Treatment plans and Quotes; staff see prices but never cost. The `quotes` table and `payments.quote_id` keep their names (renaming is cosmetic) |
| Patient page redesign | ✅ done | the patient page keeps the profile and the dental chart; **Appointments and reports** and **Documents** are pages of their own (`/patients/:id/appointments`, `/patients/:id/documents`) opened by header buttons like Payments; every page opened from a patient (those two, and Payments, Treatment offers and Lab orders filtered to the patient) has the breadcrumb Patients > name > page and the same *Back to the patient* button; the audit shortcut is an icon, and each payment row has an icon that opens its treatment offer |
| 8 Patient portal | ✅ done | view only plus cancelling with 24 h notice: `/api/v1/portal` (overview, upcoming, agreed offers with a printable copy, payments with receipts, documents marked visible with previews), `/my/*` pages (home with next appointment, balance and tiles; appointments with history and reports; treatment; payments; documents; profile), patient sign-in by username (migration 003 and the patient card), reminders a day ahead and booking/cancellation notes for patients in the bell; API and screen tests. Not built: online booking (by decision); passwords are reset by staff with a new patient card, and a mobile app may come later |
| 9 Waiting room | ✅ done | migration 004 (`waiting_tickets`), `waiting` permissions, `/api/v1/waiting-room` (numbers per clinic per day, candidates, call, finish, leave, requeue) and `/api/v1/waiting-display` (public, secret key, numbers and dental units only), the *Waiting room* page, the check-in dialog, the screen page with an optional chime and Settings > Waiting room; API and screen tests. The rest of phase 9 (events and promotions, more settings, audit extras) is not built |
| 9 Settings | ✅ done | operating settings: six pages (appointments, security, patient portal, waiting room, uploads, date and time) plus Trash and activity log retention (nightly, off until set) and a CSV export of the activity log; `GET/PUT /settings/<group>`, obeyed by booking, cancelling, reminders, sign-in, passwords, uploads, the portal, the waiting room and the screens; the environment is only the starting value |
| 9–10 | ⬜ not started (see TODO) | |

Deviations in phase 3: there is no separate `/appointments/calendar` endpoint (the calendar uses `GET /appointments?from&to&pageSize=500`); `/patients/:id/quotes|payments|chart|account` arrive with their phases; categories and teeth are read-only (CRUD later); a procedure/teeth edit screen is not built (API exists: `PUT /appointments/:id/categories|teeth`); the booking rules (slot length, working days, timezone, cancel notice) come from environment variables, not a settings screen; there is no patient portal UI yet (phase 8), though the patient API rules are implemented and tested.

Phase 2 had no email provider; since then the clinic has decided to send no email at all, so an admin hands over reset links and temporary passwords (see the progress table).

Testing throughout: unit tests for services (availability, balances, status machine), API integration tests on a throwaway DB, Playwright e2e for critical paths (login, book, record visit, pay quote, export report).

### 13.1 Patient documents (planned 2026-10-05, built 2026-10-06 as migration 021)

Doctors and staff upload files for a patient: **x-ray, panoramic, CBCT report or screenshot, blood analysis**, and anything else. Owner answers (2026-10-05): images and PDF only, 25 MB each; staff, doctors and admin upload, and doctors see only what their scope allows; files stay on the server disk under `UPLOAD_DIR`.

**Rules**
- **Types:** PNG, JPEG, WebP and PDF, **identified by their first bytes** (`sniffImage` plus a PDF check for `%PDF-`), never by file name or the `Content-Type` the client sent; no SVG, HTML, ZIP or DICOM. **Size:** 25 MB per file, one file per request (several files are sent one after another). A CBCT study as DICOM or ZIP is **not** supported yet: upload its report (PDF) or screenshots, and say so on screen. Adding DICOM/ZIP later is a new allowed type plus a bigger limit, nothing else.
- **Who:** upload: admin, staff, and doctors for patients they may see in full (`ownsPatient` through `lib/scope.ts`; an external specialist who only treats an owner's patient gets 404, like the profile and chart). Read: the same people. Edit the title, category, date, note or visit link: the uploader and admin. **Delete: the uploader and admin** (soft delete into the Trash; only admin restores or erases). **Patients see nothing in phase 8** (a "visible to the patient" switch is a later decision, default off; never add it silently). A doctor login not linked to a doctor profile sees nothing.
- **Never in PDFs, reports, notifications or patient views.** The visit summary and every report stay as they are.

**Data (next free migration number, `patient_documents`)** `id`, `patient_id` (RESTRICT), `appointment_id` (nullable: the visit it belongs to), `category` (`xray`, `panoramic`, `cbct`, `blood_test`, `other`), `title` (120), `taken_on` (date, defaults to the upload day), `note` (500, clinic only), `file_name` (random server name, `doc-<12 hex>.<ext>`), `original_name` (display only, cleaned), `mime`, `size_bytes`, `sha256` (to warn about the same file uploaded twice for a patient), `uploaded_by`, timestamps, `deleted_at`, `deleted_by`. Index on (`patient_id`, `deleted_at`). Portable SQL only.

**Storage:** `UPLOAD_DIR/documents/`; the file is written first and the row inserted after, and the file is removed if the insert fails. The name is validated against a regex before any `sendFile` (`dotfiles: 'deny'`), so ids and names can never reach another path. Erasing from the Trash, or erasing a patient, deletes the files **after** the database transaction commits.

**API** (all under `requireAuth`, permission `documents:read|create|update|delete` added to `lib/permissions.ts`, CSRF as usual)
- `GET /patients/:id/documents?category&q` list (metadata only, `{ data, meta }`).
- `POST /patients/:id/documents?category&title&takenOn&appointmentId&note` with the raw file as the body (the logo pattern, no new dependency), a rate limit, `express.raw({ limit: 25 MB })`; answers 400 `INVALID_FILE` (unknown type or empty), 413-style `FILE_TOO_LARGE` mapped to our error shape, 409 `DUPLICATE_DOCUMENT` with an `allowDuplicate=1` override, and a per-patient cap (200 files) to stop runaway disk use.
- `GET /documents/:id/file` the file itself for signed-in people allowed to read it: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, images inline, PDFs as a download or a new tab; download name built from category and date, never the original name.
- `PATCH /documents/:id`, `DELETE /documents/:id`.
- **Audit (ids and sizes only, never file names, titles or notes, which may name the patient):** `document.upload`, `document.update`, `document.delete`, and `document.view` counted as a *view* under the patient in the Activity log.
- **Trash:** new kind `document` in `modules/trash` and `trash/purge.ts` (footprint, counts, erase order, files); a patient's erase also erases their documents and files and lists the count in the warning.
- Notifications: none in the first version.

**Screens, as built:** a **Documents** page of its own (`/patients/:id/documents`), opened by a button on the patient page, with **Add documents** in the page header beside **Back to the patient**.
- A filter by kind and a search; a sortable table (title, kind, taken on, visit, added by, size; every column sorts) with open, edit and delete icons (edit and delete only for the uploader and admin).
- **Add documents** opens a dialog with a file picker (several files; no drag and drop): per file a kind, title, date and note, type and size checked first, sent one after another, with "Add it anyway" for a duplicate.
- Pictures open in a viewer with Previous and Next; PDFs open in a new tab. No thumbnails and no zoom (a 25 MB panoramic must not load in a grid). Delete asks for confirmation and goes to the Trash.
- Style, English/Arabic and toasts follow the frontend rules in CLAUDE.md; the kind names stay English.

**Tests (with the code)** API: every role (admin, owner doctor for own and other doctors' patients, external specialist in both cases, unlinked doctor, staff, patient 403), upload of each accepted type, rejection of SVG, HTML renamed to `.png`, an executable, an empty body, a fake `%PDF` extension, and 25 MB + 1 byte; random names and no path traversal; file removed when the insert fails; soft delete, Trash restore and erase remove the file; patient erase removes every file; audit contains no file name or note; response headers on the file route; the duplicate and cap rules. Web: list and filters, sorting, upload with a mocked fetch (success, type error, size error, duplicate), edit, delete, buttons by role, English-only category labels, Arabic completeness.

**Steps** (about one week): (1) migration, shared Zod schemas and `documents:*` permissions; (2) storage helper, upload/list/file/patch/delete routes, audit; (3) Trash and purge, patient erase; (4) patient-page Documents section, upload dialog, viewer; (5) tests, Arabic, toasts, activity-log labels, docs (CLAUDE.md, plan table), `UPLOAD_DIR` in the backup notes.

**Risks and notes:** this makes `UPLOAD_DIR` hold **patient health data**: it must be backed up with the database, kept out of any public web root, and the server disk should be encrypted (phase 10 checklist). No virus scan is planned in the first version (files are only ever served back with `nosniff` and a sandboxing CSP, never executed); add one if documents may come from outside the clinic. EXIF data in photos is kept as uploaded. SQLite and MySQL both store only paths, so the feature is portable; on a multi-server deployment move `UPLOAD_DIR` to shared storage.

**Later, not in this plan:** DICOM/ZIP for CBCT studies with a bigger limit; thumbnails; a "visible to the patient" switch with portal display (phase 8); retention rule for old documents; object storage.

### 13.2 Treatment offers: treatment plans and quotes become one (decided and built 2026-10-06)

**Why:** a treatment plan's items already carry a price, so a separate quote only repeats the total. Owner decision: **one record, the treatment offer**, holds what will be done (items, in order, per tooth), what it costs, what the patient agreed to and what was paid. **Payments, commission, summary, tax, reports and every other model that pointed at a quote now point at the offer.** The quote as its own thing disappears.

**Owner answers (2026-10-06)**
- **Staff** see offers with prices, totals and balances, **never the clinic's cost**; they cannot create or edit offers (as with plans today) but book the visits and record payments (the narrow "open offers" entry stays). This replaces the earlier rule that staff cannot browse quotes.
- **Status is three separate indicators:** the **offer status** (first planned as `draft`, `sent`, `accepted`, `rejected`, `expired`, `cancelled`, then **simplified the same day to `draft`, `accepted`, `cancelled`**: an offer is made in the chair after the patient agreed, so it is accepted at once, with an optional unfinished draft; migration 022); a **payment state** that is always derived (`unpaid`, `partly_paid`, `paid`; paying more than the price still counts as paid); a **work state** that is always derived from the items (`not_started`, `in_progress`, `completed`). The three are shown as chips. Nothing derived is ever stored as the manual status.
- **Old data:** every existing quote becomes an offer with **one item** (the quote's title and price, its cost kept), with the **same id and the same payments**, so balances do not change; existing treatment plans are merged in with their items. Checked against the imported totals (78 payments, $5,485) before and after.

**Model**
- **Offer** (the `treatment_offers` table, renamed from `quotes` in migration 023, and `payments.offer_id` in 024; **no start date**: dates belong to the booked visits, migration 025 dropped the column): patient, optional doctor, title, description, notes, status, `price` = **always the sum of its items** (worked out by the server in the same transaction as every item or payment change, like `recalcQuote` today), `cost` = the sum of the items' costs. Soft delete, Trash kind `offer` (replaces `quote` and `plan`).
- **Item** (`offer_items`, replacing `treatment_plan_items`): procedure (optional), tooth (optional), description, **`price`** (binding, replaces `est_price`), **`cost`** (optional, clinic's own), sequence, status (`pending`, `scheduled`, `done`), the appointment it is booked on, `completed_at`. Items of legacy quotes are created as `done` so old money never raises "visit to book" notices.
- **Rules kept:** payments only on an offer that is `sent` or `accepted` (or already has payments), refused on draft, rejected, expired or cancelled (`QUOTE_NOT_OPEN` becomes `OFFER_NOT_OPEN`); visits are booked only on an **accepted** offer through `assertBookable`; an offer's total cannot fall below what has been paid (`PRICE_BELOW_PAID`); a rejected or expired offer cannot be edited; an offer with payments cannot be rejected (it can be `cancelled` only if nothing is paid). Items of an accepted offer may still be added or changed by the doctor or admin, which changes the price and is audit-logged (field names and ids only).
- **Who:** admin and doctors (own patients, `moneyScope`) create and edit; **staff read all** (no cost) and book; patients none until phase 8; money-like, so `offers` joins `REVOKE_ONLY_MODULES` on the Roles page (replacing `quotes` and `plans`). The permission matrix gets one module, `offers`; saved `role_permissions` rows for `quotes:*` and `plans:*` are renamed by the migration.

**API** (`/treatment-offers`, replacing `/quotes` and `/treatment-plans`; `/payments` stays but takes `offerId`): list with filters and server-side sorting (status, payment state, work state, patient, debt), create with items, get, patch the header, add/change/remove/reorder items, `send`, `accept`, `reject`, `expire`, `cancel`, `items/:id/schedule` (book the visit), `items/:id/done`, `pdf`, and the staff narrow lookup. The quote PDF becomes the **offer PDF**: items with prices, total, paid and balance, never the cost.

**Everything that follows the rename** (mechanical, but all of it must be done and tested): payments and receipts, commission statement, expenses' commission checks, finance summary and debts, `byMonth`, per-doctor figures, income tax base, dashboard insights (debts, plans awaiting acceptance), reports (outstanding balances, revenue), notifications (`quote.sent`, `quote.accepted`, `plan.accepted` become `offer.sent` and `offer.accepted`, told to admins, staff and the patient's primary doctor; `plan.visit_due` follows the offer's start date), appointment dialogs that book a plan visit, the patient page, Trash and permanent erase, the Roles page labels, the activity log wording, toasts, Arabic ("Treatment offer(s)" stays English, like the other medical-term labels), and the dump import (which must create the one item per imported quote).

**Screens:** one **Treatment offers** page in the Clinic group replaces *Treatment plans* and *Quotes* (list with the three chips, filters, sorting) and one detail page (item builder with prices, status actions, payments list and *Record payment*, booking of items, PDF), replacing both detail screens; the patient page gets one section. *Payments*, *Commission* and *By doctor* keep their pages, now showing offers.

**Migrations (verified on a copy of the real database first, with money totals compared before and after):** (1) merge: add the offer columns, create `offer_items`, turn each plan with a quote into that quote's offer, each plan without a quote into a new offer, and each other quote into an offer with one item; map statuses (`partially_paid` and `paid` become `accepted`, `pending` becomes `sent`, plan `proposed` becomes `sent`, `in_progress` and `completed` become `accepted`); recompute prices from items and check every total; (2) rename tables and columns (SQLite `RENAME` updates the foreign keys; MySQL equivalents written and tested) and rename the saved role permissions; (3) drop the old plan tables only after the checks pass. **Take a copy of the dev database before the first run.** The rollback of (1) is refused once an offer has several items (it cannot be turned back into one quote).

**Steps** (one delivery, tests green at the end, about two to three weeks): (1) migrations and a verification script; (2) shared schemas and permissions; (3) the `offers` API module with its tests; (4) every dependent module above; (5) the web screens; (6) Arabic, toasts, audit labels, Roles page, docs (CLAUDE.md, README, this plan, TODO), dump import; (7) full verification, then a run on a copy of the dev data.

**Risks:** the largest change so far; it touches about 20 API files, 35 web files and 33 test files. Money totals must match to the cent before and after. The old API paths, Trash kinds and notification types disappear (old notification rows keep their type text and still display).

### Deployment
Docker images for api and web; reverse proxy (Caddy/nginx) with TLS; MariaDB managed or on a VM with nightly dumps (+ point-in-time binlog), restore tested monthly; environments: local → staging → prod; health endpoint `/healthz`; error tracking (Sentry) and uptime monitoring.

---

## 14. Decisions from the owner

Answered on 2026-10-01. These override anything earlier in this document that disagrees.

| Topic | Decision |
|---|---|
| `payments.remaining` | The balance left on the quote after that payment. Always calculated by the server. |
| `dr_part` (payments and `clinic_doctor`) | A **percentage** (100 = 100%), copied from the doctor's setting when a payment is made. |
| Old `roles` / `role_user` tables | Not needed. Drop them before launch. Auth uses `users.role` and the permission matrix. |
| Doctor schedules | **None.** No doctor has fixed working days or hours; they depend only on their appointments' dates and times. The only booking rule is that one doctor cannot have two overlapping appointments. This replaces the working-hours, working-days and "outside hours" rules built in phase 3, and removes the need for weekly-hours scheduling. |
| Opening days | Moot: with no fixed hours, any day can take an appointment. |
| Appointment length | **Variable**, chosen per appointment in 15-minute steps (default 30). The doctor or an admin can change it later. Start times are in 15-minute steps. Existing appointments become 30 minutes. |
| Timezone, cancel notice | `Asia/Beirut`, patients may cancel online at least 24 h ahead. |
| Currency | **US dollars only.** No exchange rates. |
| Roles and locations | Admin, doctor, staff. **One clinic**, containing **dental units** (see below). |
| Dental units | A clinic contains **a dental unit for each owner doctor** (Aya's unit, Sara's unit); an admin can add more units for an owner. Every appointment takes place on a dental unit. **One unit can't host two overlapping appointments**, in addition to one doctor not having two. Unit names are unique within a clinic. |
| Languages | **English and Arabic**, with right-to-left layout, for the **screens**. **PDFs (quotes, receipts, prescriptions, reports) stay English only.** Assumption: I draft the Arabic text and someone at the clinic who speaks Arabic reviews it before launch (dental terms especially). |
| Patient login | **Invited by staff only.** No self-registration. |
| Patient portal | **View only, plus cancelling their own appointment at least 24 h ahead.** Patients cannot book online; they phone the clinic. Only doctors and staff create appointments (admins can too, as they can do everything). |
| Medications | Prescribing catalog only. No stock tracking. |
| Notifications | **In-app only** for now. No email, SMS or WhatsApp. Consequence: password-reset and invite links can't be emailed, so an admin hands them over (see the to-do list). |
| Privacy | Lebanese law. Keep records indefinitely: soft deletion, access logging, backups, no automatic deletion. |
| Scale | Small, up to about 30 appointments a day. |
| Sara Doughan | Works at the clinic (bookable). |
| Outside specialists | Cidra Abou Al Nasr, Ahmad Droubi, Rabih Ghoul, Bayane Doumany, Ghina Dawoud see patients **at the clinic on set days**. The clinic's doctor can assign appointments to them, and the admin can see each specialist's appointments, quotations and payments. |
| Doctor kinds and who creates them | A doctor is either an **owner** (Aya, Sara) or **external**. The commission percentage is **required when an external doctor is created**. **Owner doctors and admins can create and edit external doctors; only admins create owner doctors.** |
| Quote amounts | `price` is the amount quoted to the patient; `cost` is the clinic's own cost (optional, 0 on existing quotes). |
| Fee paid to a specialist | The amount of a `commission` expense is **typed in each time**. |
| Who sees quotations and payments | **An admin sees everything.** A **doctor sees only the quotations of patients whose primary doctor he is**, owner or external alike (assumed to apply to payments too). **Staff cannot browse quotes or payment history**: they can record a payment against a quote they pick for a patient, and see only that quote's title, price and remaining balance. Only doctors (for their own patients) and admins create and edit quotes. |
| Visit report | When a doctor treats a patient in an appointment, **a report belongs to that appointment**; there is **at most one report per appointment**. A report is **optional**: completing a visit never requires one. In the report the doctor can **prescribe medications**. **The treating doctor and an admin can edit it, before and after the visit is completed**; every change is audited and the patient sees the latest version. **Who can read a report:** the treating doctor (an external specialist, if one treated the patient), the patient's primary doctor, admins, staff (read only), and the patient themselves. Other doctors cannot. |
| External specialists sign in | **Yes.** A specialist has a login linked to his doctor profile (`doctors.user_id`, set by an admin) and sees **his own appointments and his own patients only**. Two cases, always considered separately. **1. The patient belongs to him:** he has full working access: sets and manages the appointment, creates its quote, writes the report, opens the patient's profile, timeline and chart. **2. The patient belongs to an owner doctor and he treats them:** he sees the appointment (patient name only, no phone) and writes the report, but cannot open the patient's profile, timeline, chart or appointments, and cannot confirm, move or cancel the appointment. A doctor login that is not linked to a doctor profile sees nothing. Specialists cannot manage the clinic's doctors. |
| Medications | The medication names in the data are **dummy data for now**. Nothing to replace yet. |
| Commission percentages | The owner **sets them later**. Until then external doctors show "Not set" and commission can't be calculated. |
| Arabic | **Only the interface is translated.** Reports, prescriptions, medication and procedure names, tooth and surface names, and other medical terms **stay in English**, as do the PDFs. Arabic is drafted by me and still needs review by an Arabic speaker at the clinic. |
| Dental panorama | **One shared flat illustration of all 32 teeth, identical for every patient** (no per-patient uploads), drawn in code in two rows of 16 like a panoramic X-ray (owner chose: I draw it, clean flat style, wide layout, desktop and phone equally). The app draws each patient's teeth history over it: a tooth with history is highlighted and clickable to read that history. In the report editor the doctor selects teeth on the same picture and writes a note for each. Doctors, staff and admins can view it; patients cannot; specialists only for their own patients. **It replaces the current tooth chart everywhere.** Built. |
| Tables | **Every data column in every table is sortable.** Paginated lists sort on the server, small lists in the browser. |
| Visual style | The gradient/soft-shadow style approved on 2026-10-02 applies to every new screen (see CLAUDE.md Frontend rules). Admins and doctors are greeted as "Dr." |
| Settings page | **Planned, waiting for the owner's list of settings.** Admin only, backed by the existing `settings` table with a typed registry shared by the API and the screen. See TODO.md phase 9. |
| Deleting | **Staff and doctors soft delete; only the admin can permanently erase.** Applies to patients, appointments and reports now, and to money records in phase 5. Soft-deleted items sit in an admin-only **Trash**; the admin can restore them or erase them permanently from there (not directly from the record). Erasing a record also erases what is attached to it (for a patient: appointments, reports, quotes, payments), after a warning listing what will go and a typed confirmation. Every permanent delete is audit-logged with who, what, id, when and counts, never the content. This replaces the earlier rule that data is never erased. **Built** (migration 008; money records join in phase 5). |
| Patient timeline | A patient sees **their appointments as a timeline history, each with its report**: the **summary and the prescriptions** only. Per-tooth surface notes and internal notes stay clinic-only. |
| Who a patient belongs to | Every patient has a **primary doctor**. A quote belongs to **one patient** and can have **several appointments**, each by a different doctor, so a quote has no single doctor: its collecting doctor is the patient's primary doctor. |
| Money when the patient belongs to an **owner doctor** (Aya or Sara) | Outside specialists who treat the patient are a **third-party service**. The owner doctor collects from the patient and **pays the specialist for the service**. The specialist pays nothing. |
| Money when the patient belongs to an **outside specialist** | The specialist collects the payments. The **owner of the dental unit he treated the patient on receives a percentage of what he actually collected** (not the quote price), paid later as `commission` payments. If he treats on Aya's unit, Aya is paid; on Sara's unit, Sara. |
| Who records payments | **Only doctors and staff** (admins too). Patients can only view. |
| Payments | A payment is **money collected by a doctor**. Two types: **`clinic`** (collected from a patient; must belong to a quote) and **`commission`** (collected from an outside specialist; not tied to a quote). |
| Expenses | Money paid out, separate from payments. Five types: **personal**, **clinic** (water, electricity, things bought for the clinic), **lab** (paid to a lab for dentures, bridges, crowns; must name the lab), **supplier** (paid for dental products; must name the supplier) and **commission** (what an owner doctor pays an outside specialist for treating the owner's patient; must name the doctor and the appointment). Note the two different meanings of "commission": as a *payment* it is collected from a specialist; as an *expense* it is paid to one. |

Nothing is open from the owner's side for now. Remaining work is in [TODO.md](TODO.md).

## 15. Assumptions made

- MariaDB stays as the database; existing data is migrated in place, not re-created.
- Single deployment, single clinic location to start (schema supports several).
- In-app only notifications for v1 (per requirements), with a pluggable channel interface.
- TypeScript is acceptable for both apps (requirements say Node/React, not JS specifically).
