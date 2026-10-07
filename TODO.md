# TODO: remaining work

Only unfinished work lives here. **When a task is finished, delete its line** (don't tick it). Finished work is recorded in the Progress table of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Owner decisions are in section 14 of the plan. Design details for each phase are in section 13.

Last updated 2026-10-06, after phase 7 and its follow-ups, editable roles, treatment offers (plans and quotes merged), patient documents and the patient page redesign. Phases 0 to 7 are done.

---

## Information still needed from the owner

- [ ] **Commission percentages are still empty**, so the commission statement shows "not set" warnings until you enter them under *Doctors*.
- [ ] Have someone at the clinic who speaks Arabic review the Arabic screen text before launch (it lives in `apps/web/src/i18n/ar/`; medical terms deliberately stay English)

---

## Patient documents follow-ups

The documents, their previews and the "visible to the patient" mark are built, and the portal shows the marked ones (see CLAUDE.md). Left:

- [ ] Optional: link a document to a visit in the screens (the API already takes the visit); DICOM or ZIP studies only if the owner asks
- [ ] Before launch: encrypt the server disk (the uploads and the database hold patient health data); backups are `npm run db:dump -- --with-uploads`, see the backups item in phase 10

---

## Phase 9: Secondary modules

- [ ] Events and promotions CRUD and UI, and promotion codes and discounts on quotes (`POST /promotions/validate`; the owner chose to keep quotes to a plain price until then)

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
- [ ] Backups: schedule `npm run db:dump -- --with-uploads` (the database file plus the documents) and keep copies off the server; a MySQL deployment needs `mysqldump` instead, and a SQLite-to-MySQL data transfer is not built
- [ ] Before go-live: run `npm run db:setup` on the new server (it prints the first administrator's temporary password once), sign in and change it; set `NODE_ENV=production`, HTTPS and `TRUST_PROXY`
- [ ] Drop the unused `roles` / `role_user` tables
- [ ] Docs: user guide (English and Arabic), backup and restore, deployment
