# public/

Static files served as-is at the site root (Vite copies this folder to `dist/` on build).

- `css/`    stylesheets, e.g. `/css/print.css`
- `js/`     plain scripts, e.g. `/js/analytics.js`
- `images/` logos, icons, pictures, e.g. `/images/logo.png`

Reference them with absolute paths (`/images/logo.png`), never `../public/...`. Files are not
bundled or hashed, so use `src/` imports instead for anything the React code owns.
Don't put patient data or secrets here: everything is public.
