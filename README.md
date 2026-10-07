# Dental Clinic — Dental Management System

Full-stack web app for a dental clinic: appointments, patient records and tooth charts, treatment offers, payments and expenses, labs, medications, in-app reminders, PDF/Excel reports, and a secure login for staff and patients.

> **Status:** phases 0–7 of 10 are built: setup, database, secure sign-in with roles the admin can edit, patients, doctors and clinics, appointments with a calendar, visit records (reports, prescriptions, dental panorama), treatment offers (plans and quotes in one) with payments, expenses, commission, summary and income tax, labs, patient documents, in-app notifications and Excel/PDF reports. The interface is available in English and Arabic. The patient portal (phase 8) and the secondary modules are not built yet. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the design and the phase list.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Redux Toolkit + RTK Query, MUI, React Hook Form + Zod |
| Backend | Node.js, Express 5, TypeScript, Knex, Zod |
| Database | **SQLite** for development, MariaDB/MySQL later (config switch, see below) |
| Auth | bcrypt, JWT access token + rotating refresh token in httpOnly cookies, CSRF double-submit |
| Tests | Vitest, Supertest, React Testing Library |

## Layout

```
apps/api        Express API, Knex migration, setup and admin scripts
apps/web        React SPA (Vite dev server proxies /api to the API)
packages/shared Zod schemas and types used by both apps
```

## Getting started

Requires Node 22 or newer. No database server is needed.

```bash
npm install
cp apps/api/.env.example apps/api/.env     # then set JWT_SECRET (see the file)
npm run db:setup -- --admin-name "Dr Name" --admin-email you@clinic.example
npm run dev                                # API http://localhost:4000, web http://localhost:5180
```

**This is a new installation, not an upgrade:** the project is deployed from zero on a new server and carries no data from the old app. `db:setup` creates the empty database (`apps/api/data/dental_clinic.sqlite`, one migration holds the whole schema), adds the 32 teeth, and creates the **first administrator**. It prints a random temporary password once; the administrator must change it at the first sign-in (pass `--admin-password` to choose one). It is safe to run again: nothing that exists is touched, and a second administrator is never created this way. Everything else (clinic, doctors, procedures, medications, patients) is entered in the app.

**Signing in:** use the administrator's email and the temporary password. To set a new temporary password for anyone later:

```bash
npm run user:set-password -w apps/api -- you@clinic.example
```

It prints a random password, and you must change it at the next sign-in. The clinic sends **no email**: a forgotten password is fixed by an admin under *Users*, who makes a one-time **reset link** (valid 24 hours, lets the person choose their own password) or a temporary password and hands it over in person or by phone. *Users* also creates accounts, including logins for doctors (then link the login under *Doctors > Edit*), and switches accounts on or off.

### Backups and moving to another server

`npm run db:dump -- --with-uploads` writes a checked copy of the whole database (schema and data) to `apps/api/data/backups/`, with the patient document files next to it. It is safe while the app runs and never overwrites a file. To restore, or to move to a new host: stop the app, copy the dump to the path in `DB_FILENAME`, copy the documents folder to `apps/api/data/uploads`, and run `npm run db:migrate` (it should say the database is up to date). The data lives only in those files, never in Git. A MySQL deployment needs `mysqldump` instead (this command refuses MySQL), and there is no SQLite-to-MySQL data transfer yet.

### Opening the app from another device on the same network

The dev server listens on every network interface. Restart `npm run dev`, find this computer's address (`ipconfig`, the IPv4 line, for example 192.168.18.183) and open `http://192.168.18.183:5180` on the other device. Only port 5180 is needed: the web server forwards `/api` to the API, so the browser sees one origin and CORS does not come into it. If it still does not open, Windows Firewall is blocking it: allow Node.js on **private** networks (or allow inbound TCP 5180). Set `APP_URL=http://192.168.18.183:5180` in `apps/api/.env` so reset links made on the Users page open on the other device; `CORS_ORIGIN` (comma-separated) is only for a browser app that calls the API directly on port 4000.

### Switching to MariaDB/MySQL later

Create an empty database, then in `apps/api/.env` set:

```
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=dental_clinic
```

and run `npm run db:setup` (it creates the schema in that database). The same migration runs on both. Do this before go-live, and run the tests against MySQL once, because SQLite is more forgiving than MySQL about some things (for example column widths).

## What you can do now

- **Patients:** search, add, edit, view history, delete (today admin only, and records are kept, not erased). Staff and doctors can delete (it goes to the **Trash**); only the admin can restore it or erase it for good.
- **Appointments:** calendar (day, week, month, list), a **By unit** view with one column per dental unit for a chosen day (click an empty spot to book it), and a filterable list (doctor, dental unit, status, dates); book, reschedule, confirm, cancel, mark no-show, complete a visit. Each appointment has a start time, a length (15-minute steps) and a dental unit. Only doctors, staff and admins book; patients can't.
- **Visit reports:** in an appointment, the treating doctor (or an admin) writes the report: what was done, notes on individual teeth (click the teeth on the dental panorama), and the prescription (medications from the catalog, dose, how often). It is optional and there is one per appointment. Staff and the patient's primary doctor can read it; a patient (portal, later) sees the summary and prescription only. *Visit summary (PDF)* gives the patient a printout. On the patient page you get the full appointment history with each report, and the dental chart of every tooth note ever recorded.
- **Medications** (admin and doctors) and **Procedures** (admin): the lists reports and appointments are built from. The medication names in your current data are dummy data for now.
- **Arabic:** the **العربية** button (top bar and sign-in page) switches the whole interface to Arabic with right-to-left layout, and remembers the choice in that browser. Only the interface changes: reports, prescriptions, medication and procedure names, tooth names and the PDFs stay in English.
- **External specialists:** an external doctor with a login (an admin links it under *Doctors & clinics > Edit*) sees only his own appointments and patients. For his **own patients** he works as a doctor does: books and manages their appointments and writes reports. For an **owner doctor's patient he treats**, he sees the appointment and writes the report, but cannot open the patient's profile or data.
- **Treatment offers and payments:** a treatment offer is what will be done (items in order, each with a price), what it costs and what was paid: it replaces the separate treatment plan and quote. A doctor writes an offer for his own patients **in the chair, after the patient agreed: a new offer is accepted at once** (he can keep an unfinished one as a draft and accept it later, or cancel one that is not going ahead), books the visits of its items, and records payments on it (cash, card, bank transfer, other). Three indicators sit side by side and never mix: the offer's status (draft, accepted or cancelled), whether it is unpaid, partly paid or paid (worked out from the payments) and how far the work has got (worked out from the items). The price is always the sum of the items; a payment above what is owed is accepted (the offer simply counts as paid). Admins see all offers and payments; a doctor only those of his own patients; **staff** see every offer with its prices (never the clinic's cost) and book its visits. Staff use the **Payments** page to record a payment (pick the patient, then one of their open offers) and can fix or delete only their own entries; they cannot browse payments. Deleted offers and payments go to the Trash. A **Payments** button on the patient page (admins and doctors) lists all of that patient's payments, and every row of the payments table has an **icon that opens its treatment offer**.
- **PDFs for patients:** an **Offer (PDF)** button on a treatment offer and a **receipt** icon on every payment (doctors, admins, and staff for the payments they entered). Offers list their items with prices, the total and what is paid, but never the clinic's own cost. English only.
- **Month by month** (bottom of the Summary page): a chart of payments and expenses for every month of the chosen period, with the figures (and the net) when you hover or focus a month, and a table view.
- **By doctor** (admin: every doctor; a doctor: himself): for the chosen period, the offers made, the money collected, what the doctor's patients still owe today, the commission balance (what specialists owe an owner, or what a specialist owes the owners) and the specialist fees.
- **A new patient needs a primary doctor**, because a doctor collects the payments of his own patients.
- **Expenses** (admin and staff; doctors see none): money paid out, as personal (admin only), clinic, lab, supplier or specialist fee. A lab expense names the lab, a supplier expense the supplier, and a specialist fee names the specialist and the visit (an owner paying a specialist for treating the owner's patient).
- **Commission** (admin, owner doctors and specialists): an outside specialist owes the owner of the dental unit he used a percentage of what he collected. For each payment the owner is the owner of the unit of the patient's latest visit on or before that date. The page shows, per specialist and owner, what was collected, owed, received and the balance, for any period; owners and admins record what a specialist paid over. Fees owners paid specialists for the owners' own patients are listed separately.
- **Summary** (admin): pick a period (this month, last month, this year, all time, or any dates) and see the **total payments** (payments from patients plus commission received from specialists, listed by type), the **total expenses** (with what they were made of), the **net profit** (payments minus expenses, shown in red when negative) and **patients' total debts** (what open quotes still owe today, with the biggest debtors). Buttons open the payments, expenses and debts behind each figure. The commission button opens the Commission page for the same period.
- **Patient page:** it holds the profile, the dental chart and a row of buttons. **Appointments and reports** (the patient's visits, each with its report) and **Documents** open pages of their own (`/patients/:id/appointments`, `/patients/:id/documents`) with the patient's name under the title, a **Back to the patient** button and a breadcrumb through the patient; **Payments**, **Treatment offers** and **Lab orders** open the full lists filtered to that patient, with the breadcrumb Patients > name > list and the same **Back to the patient** button as the other patient pages. The audit shortcut for admins is a history icon.
- **Documents:** a **Documents** page of its own (button **Documents** on the patient page; its **Add documents** button sits in the header beside **Back to the patient**, like **Record payment** on the Payments page) keeps the patient's x-rays, panoramics, CBCT reports and blood analysis (pictures and PDF files, up to 25 MB each, on the server). Admin, staff and doctors add and open them (a doctor only for his own patients; an outside specialist only for patients who are his own); the person who added a document, and admins, can change or delete it, and a deleted one goes to the Trash. Several files can be added at once, each with its own kind, title and date; pictures open in a viewer, PDF files in a new tab. Patients do not see documents yet.
- **Trash** (admin): everything staff and doctors deleted (patients, appointments, visit reports), with who and when. The admin can **restore** an item or **erase it for good**: a warning lists exactly what goes (for a patient: appointments, reports, tooth notes, prescriptions, quotes, payments, the patient's login) and the admin must type the patient's name. Every erase is logged without any content.
- **Confirmations:** every successful add, save, delete, restore, confirm or cancel shows a short message at the bottom of the screen (in the chosen language); failures are shown where they happened.
- **Activity log** (admin): who opened or changed what, and when, with filters (everything / who opened records / changes and sign-ins, person, dates). Opening a patient's profile, history, teeth chart, appointments, an appointment or a report is recorded under that patient (ids only, never content). On a patient page the admin has a **history icon** (its tooltip says "Who viewed this record") that opens that patient's log. Each row has an **X** that deletes that one entry (leaving a note that an entry was deleted). The admin can also **Clear the log** (erases every entry for everyone, after a confirmation); one entry remains saying who cleared it and how many entries went.
- **Side menu:** pages are grouped (**Clinic**, **Finance**, **Catalog**, **Administration**) under coloured headers. Click a header to fold or open its group; the choice is remembered in the browser, and the group of the page you are on always opens. You only see the groups you have pages in.
- **Doctors and Clinics** are separate menu pages. *Doctors* (admin, owner doctors) manages doctors; *Clinics* (admin) manages clinics, dental units, who works where, and the **clinic logo** (PNG, JPEG or WebP up to 512 KB; shown next to the clinic name). Uploaded logos are stored in `UPLOAD_DIR` (default `apps/api/data/uploads`): back that folder up with the database. The app logo is `apps/web/public/images/logo.png`.
- **Doctors & clinics (details):** doctors are *owners* (Aya, Sara) or *external* specialists, who need a commission percentage. Admins manage everyone; owner doctors can add and edit external doctors. Each owner has a dental unit in the clinic, and admins can add more under *Clinics & units*. **A doctor can only be booked once assigned to a clinic** (admin: *Doctors & clinics*). In your development data, Dr Aya and Dr Sara are owners with their units, and all seven doctors are assigned to the clinic. The five external doctors have no commission percentage yet ("Not set"); set each later under *Doctors & clinics > Doctors*. Note that `npm run db:import -- --reset` returns the database to the original dump and undoes this setup.

### Booking rules

Doctors have no fixed working days or hours, so any day and time can be booked. The rules are: a doctor can't be in two appointments at once, a dental unit can't hold two at once, and an appointment must end before midnight. Staff may record past visits. Only a doctor or admin can change a booked appointment's length. Settings in `apps/api/.env`: `CLINIC_TIMEZONE` (default `Asia/Beirut`) and `CANCEL_MIN_HOURS` (default 24, how far ahead a patient may cancel).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API and web together |
| `npm run build` | Production build of the web app |
| `npm test` | All tests (API and web) |
| `npm run typecheck` | TypeScript check of every package |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:dump [-- file] [--with-uploads]` | Dump the database (schema and data) to one SQLite file in `apps/api/data/backups/`, checked and never overwriting; `--with-uploads` also copies the patient documents. Restore: stop the app and copy the file to `DB_FILENAME` |
| `npm run db:setup -- --admin-name ... --admin-email ...` | New installation: schema, the 32 teeth, the first administrator (safe to repeat) |
| `npm run user:set-password -w apps/api -- <email> [password]` | Set a user's password (forces a change at next login) |

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Foundation | done |
| 1 | Schema hardening | done |
| 2 | Auth & RBAC | done |
| 3 | Core clinical (patients, doctors/clinics, appointments, calendar) | done |
| 4 | Visit records (tooth chart, prescriptions) | done |
| 4b | Dental panorama (shared tooth picture with patient history, replaces the tooth chart) | done |
| 5 | Money (payments, expenses, commission) | done: payments, expenses, commission, summary with chart, by-doctor figures and PDFs |
| 6 | Treatment offers and labs (treatment plans and quotes merged into offers with bookable priced items; lab orders, labs and suppliers) | done |
| 7 | Notifications and reports (in-app notifications with a bell, reminders, Excel and PDF reports) | done |
| Extras | Roles and permissions (admin editable), income tax, settings, background reports, patient documents, deleted-clinic data rules | done |
| 8–10 | Patient portal, secondary modules, launch | not started |

## Security notes

- Patient data is sensitive health data. Check which privacy rules apply (HIPAA, GDPR or local law) before going live.
- Before launch: set `NODE_ENV=production` (secure cookies), put the API behind HTTPS, and set `TRUST_PROXY=true` if behind a reverse proxy.

## Documents

- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — architecture, API, frontend, security, phases, open questions
- [TODO.md](TODO.md) — everything still to do, by phase
- [CLAUDE.md](CLAUDE.md) — working instructions for Claude Code
