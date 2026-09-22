# L.J. Industries Cloud ERP — Backend

This turns the original single-file demo (`erp.html`, which stored everything
in the browser's `localStorage` and used a hardcoded `admin` / `admin123`
login) into a real, hostable app:

- **Database:** SQLite (file-based, via `better-sqlite3`) — one `users` table
  for login accounts, one `app_data` table holding the ERP's working data.
- **Authentication:** real accounts, `bcrypt`-hashed passwords, JWT session
  tokens (8-hour expiry), a rate limiter on the login endpoint.
- **Frontend:** `public/app.html` — the same UI as the original file, with
  its data layer swapped from `localStorage` to calls against the API below.

## Project layout

```
lj-erp-backend/
├── server.js          Express app: API routes + serves the frontend
├── init-admin.js       One-off script to create/reset the admin login
├── package.json
├── .env.example        Copy to .env and fill in
├── data/                SQLite database file lives here (created at runtime)
└── public/
    └── app.html         The frontend (open this in a browser via the server)
```

## Run it locally

```bash
npm install
cp .env.example .env
# edit .env: set a real JWT_SECRET and ADMIN_PASSWORD
npm run init-admin        # creates the admin login from .env
npm start                 # starts the server on http://localhost:3000
```

Open `http://localhost:3000` and log in with the username/password you set
in `.env`.

## API

| Method | Path              | Auth | Purpose                              |
|--------|-------------------|------|---------------------------------------|
| POST   | `/api/auth/login` | none | `{username, password}` → `{token}`    |
| GET    | `/api/auth/me`    | JWT  | Verify the current session            |
| GET    | `/api/data`       | JWT  | Fetch the full ERP dataset            |
| PUT    | `/api/data`       | JWT  | Save the full ERP dataset             |
| GET    | `/health`         | none | Health check for uptime monitors      |

`GET`/`PUT /api/data` currently move the whole dataset (companies, parties,
boxes, reels, orders, etc.) as one JSON document — this mirrors how the
original frontend already worked in memory, so almost none of its ~600 lines
of UI logic had to change. It's a fine model for one team sharing one
instance. If you outgrow it — many people editing at once, needing
per-record permissions or audit history — the next step is normalizing
`app_data` into real tables (`companies`, `reels`, `orders`, ...) with
row-level endpoints; ask and I can help build that migration.

## Security notes before you go live

- **Set a strong, unique `JWT_SECRET`.** Generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- **Set a strong `ADMIN_PASSWORD`** before running `npm run init-admin`, and
  change it (re-run the script) if it was ever shared or committed anywhere.
- **Never commit `.env`** — it's already in `.gitignore`.
- **Always run behind HTTPS in production** (see deployment options below) —
  tokens and passwords must not travel over plain HTTP.
- **Set `CORS_ORIGIN`** to your real domain once you have one, instead of `*`.
- **Back up `data/erp.sqlite` regularly** — it's the entire database. A
  simple cron job copying it to off-server storage (S3, another disk) is
  enough for a single-file SQLite setup.
- Add more users the same way as the admin: `node init-admin.js <username> <password>`.

## Deployment options

### Option A — Managed platform (simplest)
Services like **Render**, **Railway**, or **Fly.io** can run this as-is:
1. Push this folder to a Git repo.
2. Create a new "Web Service" pointing at it; build command `npm install`,
   start command `npm start`.
3. Set the environment variables from `.env.example` in the platform's
   dashboard (don't upload `.env` itself).
4. Attach a persistent volume/disk for the `data/` folder so the SQLite file
   survives restarts and deploys (all three platforms support this).
5. The platform gives you HTTPS automatically.

### Option B — Your own VPS (Ubuntu/Debian example)
```bash
# On the server
sudo apt update && sudo apt install -y nodejs npm nginx
git clone <your-repo-url> lj-erp && cd lj-erp
npm install
cp .env.example .env   # edit it
npm run init-admin

# Keep it running with PM2
sudo npm install -g pm2
pm2 start server.js --name lj-erp
pm2 save
pm2 startup            # follow the printed instructions to survive reboots
```

Put Nginx in front as a reverse proxy (`/etc/nginx/sites-available/lj-erp`):
```nginx
server {
    listen 80;
    server_name erp.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/lj-erp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d erp.yourdomain.com   # free HTTPS certificate
```

### Option C — Docker (if you'd rather containerize)
Not included here to keep this deliverable focused, but the app needs
nothing exotic — a standard `node:18-slim` base image, `npm install`,
`EXPOSE 3000`, and a mounted volume for `data/` works. Ask if you'd like a
`Dockerfile` and `docker-compose.yml` added.

## What changed in the frontend

Only the data-loading, saving, and login logic in `app.html` was touched —
the DOM building, business logic (costing, stock ledgers, reports, etc.) is
untouched:
- `loadDB()`/`saveDB()` now call `GET`/`PUT /api/data` instead of reading and
  writing `localStorage`.
- `Auth.login()` now POSTs to `/api/auth/login` and stores the returned JWT
  in `sessionStorage`; `Auth.logout()` clears it.
- On page load, an existing token is verified against `/api/auth/me` before
  resuming the session, instead of trusting a plain `"true"` flag.
