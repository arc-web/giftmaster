# GiftMaster — Hetzner VPS Setup (Claude Code Prompt)

Copy everything below the line and paste into Claude Code.

---

Read docs/INFRASTRUCTURE.md and docs/MESSAGING.md in this repo for full context on what we're building.

## Context

GiftMaster is a Next.js 14 app deployed on Vercel with Supabase for auth and data. This VPS will run:
1. The Browser Agent API — a Node.js service that uses Playwright to research gifts, make reservations, and order items on behalf of users
2. ZeroClaw — a Rust-based messaging runtime that sends reminders and handles conversational interactions via WhatsApp/Telegram

The Agent API will be called server-to-server from Next.js API routes on Vercel (not from the browser directly). ZeroClaw will send proactive messages to users and receive replies via webhooks.

## Server Details

- IP: 87.99.133.69
- OS: Ubuntu 24.04 (fresh install)
- Access: root with password (I'll provide when prompted)
- Spec: CPX11 — 2 vCPU, 2GB RAM, 40GB SSD, Ashburn VA

## Supabase Connection

- Project ID: zqydrgcqpvslqkregawa
- URL: https://zqydrgcqpvslqkregawa.supabase.co
- Anon Key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxeWRyZ2NxcHZzbHFrcmVnYXdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3ODcwOTMsImV4cCI6MjA5MTM2MzA5M30.3yVWC8fwc0u3FEdy4ua85Bezax8ia54QQFraZU29S04

## Setup — Execute in order

SSH into root@87.99.133.69 and perform all of the following:

### Phase 1 — System Basics
1. apt update && apt upgrade -y
2. hostnamectl set-hostname giftmaster-agent
3. timedatectl set-timezone UTC
4. apt install -y curl wget git build-essential pkg-config libssl-dev unzip

### Phase 2 — Node.js 20
1. Install Node.js 20 via NodeSource: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
2. Install PM2 globally: npm install -g pm2
3. Verify: node --version && pm2 --version

### Phase 3 — Redis
1. apt install -y redis-server
2. Edit /etc/redis/redis.conf: set bind to 127.0.0.1 ::1
3. systemctl enable redis-server && systemctl restart redis-server
4. Verify: redis-cli ping (should return PONG)

### Phase 4 — Playwright
1. npx -y playwright install-deps
2. npx -y playwright install chromium
3. Verify Chromium installed successfully
Note: With 2GB RAM, set MAX_CONCURRENT_BROWSERS=1

### Phase 5 — Rust & ZeroClaw
1. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
2. source $HOME/.cargo/env
3. git clone https://github.com/zeroclaw-labs/zeroclaw.git /opt/zeroclaw
4. cd /opt/zeroclaw && cargo build --release
   (This takes several minutes on CPX11 — that's expected)
5. cp target/release/zeroclaw /usr/local/bin/zeroclaw
6. mkdir -p /root/.zeroclaw
7. Create /root/.zeroclaw/config.toml:

api_key = "PLACEHOLDER_ANTHROPIC_KEY"
default_provider = "anthropic"
default_model = "anthropic/claude-sonnet-4-20250514"
default_temperature = 0.7

[memory]
backend = "sqlite"
auto_save = true

[gateway]
require_pairing = true
allow_public_bind = false

[autonomy]
level = "supervised"
workspace_only = true
allowed_commands = ["git", "npm", "node", "curl"]
forbidden_paths = ["/etc", "/root/.ssh", "/root/.gnupg"]

# Uncomment and configure when ready:
# [channels_config.whatsapp]
# access_token = "EAABx..."
# phone_number_id = "123456789"
# verify_token = "giftmaster-verify-secret"
# allowed_numbers = ["*"]

# [channels_config.telegram]
# token = "bot123456:ABC..."
# allowed_users = ["*"]

### Phase 6 — Agent API

Create /opt/giftmaster-agent/ with a full Node.js Express app:

The API has these endpoints:
- GET /health — returns queue status (no auth)
- POST /tasks — queue a new agent task (auth required)
- GET /tasks/:id — check task status (auth required)
- POST /tasks/:id/cancel — cancel a task (auth required)

Auth is via a shared secret in the Authorization: Bearer header, validated against AGENT_SECRET env var. This secret will be shared with the Vercel Next.js app for server-to-server calls.

The task queue uses BullMQ backed by Redis with concurrency=1 (due to 2GB RAM limit).

Task types: research_gifts, book_reservation, order_flowers, custom

Each task type has its own worker file in /opt/giftmaster-agent/workers/:
- research-gifts.js — uses Claude API to generate search strategy, then Playwright to browse
- book-reservation.js — stub for now
- order-flowers.js — stub for now
- custom-task.js — stub for now

The research-gifts worker should:
1. Call Claude API to analyze the person's context and generate search queries
2. Use Playwright to open a headless browser and execute searches
3. Call Claude API again to evaluate and rank results against the person's preferences
4. Return structured results with title, URL, price, confidence score, and reasoning

All workers update the Supabase agent_tasks table with status changes (in_progress, completed, failed) using the Supabase service key.

.env file for /opt/giftmaster-agent/:
PORT=3001
NODE_ENV=production
ANTHROPIC_API_KEY=PLACEHOLDER
SUPABASE_URL=https://zqydrgcqpvslqkregawa.supabase.co
SUPABASE_SERVICE_KEY=PLACEHOLDER
AGENT_SECRET=PLACEHOLDER_SHARED_SECRET
ALLOWED_ORIGINS=https://claudeconference-pod-d.vercel.app
REDIS_URL=redis://127.0.0.1:6379
MAX_CONCURRENT_BROWSERS=1
TASK_TIMEOUT_MS=300000

Dependencies: express, bullmq, ioredis, playwright, dotenv, helmet, cors, @anthropic-ai/sdk, @supabase/supabase-js

### Phase 7 — PM2 Process Management
1. Create ecosystem.config.js in /opt/giftmaster-agent/ with max_memory_restart: '500M'
2. pm2 start ecosystem.config.js
3. pm2 startup && pm2 save

### Phase 8 — Nginx Reverse Proxy
1. apt install -y nginx
2. Create /etc/nginx/sites-available/giftmaster-agent with reverse proxy to localhost:3001
3. Include proxy headers (X-Real-IP, X-Forwarded-For, Host)
4. Set proxy_read_timeout to 300s (agent tasks can take a while)
5. Enable the site, remove default, nginx -t && systemctl reload nginx

### Phase 9 — Firewall
1. ufw allow 22/tcp
2. ufw allow 80/tcp
3. ufw allow 443/tcp
4. ufw --force enable

### Phase 10 — SSH Key Setup
1. ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ""
2. cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
3. Show me the private key so I can save it locally
4. Set PasswordAuthentication no in /etc/ssh/sshd_config
5. systemctl restart sshd

### Phase 11 — Verification
Run all of these and show me the results:
1. node --version
2. redis-cli ping
3. pm2 list
4. curl -s http://localhost:3001/health
5. nginx -t
6. ufw status
7. which zeroclaw
8. systemctl status redis-server --no-pager
9. df -h /
10. free -h

Give me a complete summary of what's running, any errors encountered, and next steps.
