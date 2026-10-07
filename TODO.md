# TODO: remaining work

Only unfinished work lives here. **When a task is finished, delete its line** (don't tick it). Finished work is recorded in the Progress table of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Owner decisions are in section 14 of the plan. Design details for each phase are in section 13.

Last updated 2026-10-06, after phase 7 and its follow-ups, editable roles, treatment offers (plans and quotes merged), patient documents and the patient page redesign. Phases 0 to 7 are done.

---

## Information still needed from the owner

- [ ] **Commission percentages are still empty**, so the commission statement shows "not set" warnings until you enter them under *Doctors*.
- [ ] Have someone at the clinic who speaks Arabic review the Arabic screen text before launch (it lives in `apps/web/src/i18n/ar/`; medical terms deliberately stay English)

---

## Phase 7 follow-ups

Phase 7 is built (see CLAUDE.md). Left:

- [ ] Reminders and notifications for **patients**: the owner will decide in phase 8 how patient accounts are provided; nothing is built until then (the generator already supports it)

---

## Treatment offers follow-ups

The statuses are now draft, accepted and cancelled (migration 022 applies by itself when the API starts; it cannot be rolled back).

The merge is built (see CLAUDE.md and section 13.2 of the plan). Left:

- [ ] Look at the Treatment offers list and detail pages in the browser, in both languages and in dark mode; check the old data (70 offers with one item each) reads sensibly
- [ ] **Before the first real deployment, back up the database:** migration 020 (treatment offers) cannot be rolled back, and it applies by itself when the API starts. (The dev database was migrated on 2026-10-06: 70 offers, $7,850 and 78 payments, $5,485, all unchanged.)

---

## Patient documents follow-ups

The documents are built (see CLAUDE.md). Left:

- [ ] Look at the Documents section on a patient page in the browser, with a real x-ray, a panoramic and a PDF, in both languages and in dark mode
- [ ] Owner: say if patients should later see some documents in the portal (a "visible to the patient" switch, phase 8), and whether CBCT studies as DICOM/ZIP are needed
- [ ] Optional: thumbnails for pictures, and linking a document to a visit in the screens (the API already takes the visit)
- [ ] Back up `UPLOAD_DIR` (it now holds patient health data) with the database, and encrypt the server disk before launch

---

## Phase 8: Patient portal

- [ ] **Timeline history:** the patient sees their appointments as a timeline, newest first, each expandable to its report (summary and prescriptions only); links to the printable visit summary
- [ ] Staff action "invite to portal" (`POST /patients/:id/account`): creates the login, links `patients.user_id`, and shows staff a one-time link or temporary password to hand to the patient
- [ ] Portal UI (English and Arabic; use the existing translation layer), view only: upcoming appointments with a cancel button (24 h notice) and balance, NO booking (patients phone the clinic), own appointments, plans, quotes, payments, profile
- [ ] Patient view of own visit summary PDF
- [ ] Mobile polish; optionally installable (PWA)

## Phase 9: Secondary modules

- [ ] Events and promotions CRUD and UI, and promotion codes and discounts on quotes (`POST /promotions/validate`; the owner chose to keep quotes to a plain price until then)
- [ ] Waiting-room numbering (`numbering`, `ENABLE_PATIENT_NUMBERING` setting)
- [ ] More **Settings** options when the owner asks (the page, General, Appearance and Taxes sections exist; candidates: default appointment length, cancel notice hours, reminder lead time, which are still fixed in the environment or code)
- [ ] Audit log extras (the Activity log page exists): export to CSV, and a retention rule (how long entries are kept)

## Phase 10: Hardening and launch

- [ ] Include `UPLOAD_DIR` (clinic logos) in backups; on a multi-server deployment move uploads to shared storage
- [ ] Visual review of every screen at phone and desktop width in both languages (the restyle was done by theme, tests cannot judge looks)
- [ ] Prettier and a pre-commit hook (ESLint is set up: `npm run lint`; the code is not yet Prettier-formatted, so adding it means one big reformat commit)
- [ ] Playwright end-to-end tests: sign in, book, record a visit, pay a quote, export a report, in both languages
- [ ] Run the whole test suite against MySQL/MariaDB (switch `DB_CLIENT=mysql`), including concurrent booking with row locking, and migration 004 up and down (its MySQL branch and the SQLite branch differ, and only the SQLite one has been run; rolling back 004 is refused on SQLite). At about 30 appointments a day, SQLite with nightly backups is also workable; decide before launch
- [ ] On MySQL, make `appointments.unit_id` NOT NULL (SQLite can't alter it; the API already requires it)
- [ ] Optional two-factor login for admin and doctor
- [ ] Breached-password check instead of the current common-list check
- [ ] Penetration-test checklist and load test
- [ ] Backups and a tested restore, monitoring and error tracking
- [ ] Production deployment: HTTPS, `NODE_ENV=production`, `TRUST_PROXY`, a real `JWT_SECRET`, reverse proxy
- [ ] Rotate the admin password and keep `aya_clinic.sql` out of any public repository
- [ ] Drop the unused `roles` / `role_user` tables
- [ ] Docs: user guide (English and Arabic), backup and restore, deployment
