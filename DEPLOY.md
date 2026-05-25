# VOID Platform — Deployment Guide
# From your PC to the internet in ~30 minutes

## What you need (all free to start)
- GitHub account — github.com
- Railway account — railway.app (free tier, no credit card needed)
- Your domain (optional, can use Railway's free subdomain)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP A — Push code to GitHub
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Install Git: https://git-scm.com/download/win
2. Open cmd inside void-backend-final folder
3. Run these commands one by one:

   git init
   git add .
   git commit -m "VOID Platform initial commit"

4. Go to github.com → New repository → name it "void-backend"
5. Copy the commands GitHub shows you under "push existing repository"
   They look like:
   git remote add origin https://github.com/YOURNAME/void-backend.git
   git push -u origin main

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP B — Deploy backend on Railway
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Go to railway.app → Login with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your void-backend repo
4. Railway auto-detects Node.js and deploys it

5. Add a PostgreSQL database:
   - In your project → "New" → "Database" → "PostgreSQL"
   - Railway creates it and gives you a DATABASE_URL automatically

6. Run the schema on the Railway database:
   - Click the PostgreSQL service → "Data" tab → "Query"
   - Paste the entire contents of void_schema.sql and run it

7. Set environment variables:
   - Click your backend service → "Variables" tab
   - Add every variable from .env.production
   - Set DATABASE_URL to the one Railway generated (copy from PostgreSQL service)
   - Generate JWT secrets: open cmd and run:
     node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
     Run it twice — one for JWT_ACCESS_SECRET, one for JWT_REFRESH_SECRET

8. Railway gives you a public URL like:
   void-backend-production.up.railway.app
   That's your live API!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP C — File storage (Cloudflare R2 — free)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Right now uploads save to your server's local disk.
For production, move them to cloud storage so they survive redeploys.

1. Go to cloudflare.com → Sign up free
2. Go to R2 → Create bucket → name it "void-uploads"
3. Create an API token with R2 read/write permissions
4. Add to Railway environment variables:
   R2_ACCOUNT_ID=your-account-id
   R2_ACCESS_KEY=your-access-key
   R2_SECRET_KEY=your-secret-key
   R2_BUCKET=void-uploads
   R2_PUBLIC_URL=https://pub-xxxxx.r2.dev

Note: The upload controller is ready for this — just swap
the local file save for an R2 put call when you're ready.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP D — Custom domain (optional)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Buy a domain (Namecheap, Cloudflare — ~$10/year)
2. In Railway → your backend service → "Settings" → "Domains"
3. Click "Custom Domain" → enter api.yourdomain.com
4. Railway gives you a CNAME record
5. Add it in your domain registrar's DNS settings
6. Update FRONTEND_URL and BASE_URL in Railway variables

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP E — Stripe live payments (when ready to earn)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Go to stripe.com → Create account
2. Complete identity verification
3. Get your live keys from Dashboard → API keys
4. Update STRIPE_SECRET_KEY in Railway to the live key
5. Set up a webhook:
   - Stripe Dashboard → Webhooks → Add endpoint
   - URL: https://api.yourdomain.com/api/monetization/webhook
   - Events: customer.subscription.* and payment_intent.*
6. Copy webhook secret to STRIPE_WEBHOOK_SECRET

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## COSTS AT SCALE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Development (0 users):     $0/month
Launch (< 500 users):      $0-5/month (Railway free tier)
Growing (500-5000 users):  ~$20-50/month (Railway Pro + R2)
Scale (5000+ users):       ~$100-200/month

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## CHECKLIST BEFORE GOING LIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ ] JWT secrets are long random strings (not the defaults)
[ ] NODE_ENV=production in Railway variables
[ ] Database schema loaded on Railway PostgreSQL
[ ] ANTHROPIC_API_KEY set (for void.ai features)
[ ] FRONTEND_URL points to your actual frontend domain
[ ] Health check passes: https://your-railway-url/health
[ ] Test register with an invite code end-to-end
[ ] Test sending a message via WebSocket
