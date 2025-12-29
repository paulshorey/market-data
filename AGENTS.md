# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform: Railway

This application is hosted on [Railway](https://railway.com), a modern deployment platform.

### Railway Platform Summary

**What is Railway?**
Railway is a deployment platform that provisions infrastructure, enables local development with that infrastructure, and deploys to the cloud. It offers automatic builds, scaling, and easy database provisioning.

**Key Features:**
- **Automatic Deployments** - Deploy from GitHub with auto-deploys on push, or via CLI with `railway up`
- **Config as Code** - Use `railway.json` or `railway.toml` to define build/deploy settings in your repo
- **Private Networking** - Services within a project communicate via `*.railway.internal` domains without egress costs
- **Environment Variables** - Reference variables across services using `${{ServiceName.VARIABLE}}` syntax
- **Healthchecks** - Configure `/health` endpoints for zero-downtime deployments
- **Horizontal Scaling** - Scale replicas across multiple regions

**Best Practices (from Railway docs):**
1. **Use Private Networking** - Connect to databases and internal services via `*.railway.internal` for faster, free internal traffic
2. **Deploy Related Services Together** - Keep related services in the same project for private networking and easy variable sharing
3. **Use Reference Variables** - Don't hardcode URLs; use `${{Postgres.DATABASE_URL}}` to keep values in sync
4. **Listen on `::`** - Bind to all interfaces for IPv4/IPv6 support in private networking
5. **Configure Healthchecks** - Ensure zero-downtime deployments with `/health` endpoint

**Config as Code:**
The `railway.json` file in the project root defines deployment configuration:
- Build settings (builder, commands)
- Deploy settings (start command, healthcheck path/timeout, restart policy)
- Environment-specific overrides

**Deployment Commands:**
```bash
# Initialize project
railway init

# Deploy
railway up

# Add database
railway add -d postgres

# Generate public domain
railway domain

# Run local with Railway environment
railway run npm start
```

## Getting started

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file from example:
   ```bash
   cp .env.example .env
   ```

3. Start development server:
   ```bash
   npm run dev
   ```

### Deploy to Railway

1. Install Railway CLI and login
2. Run `railway init` to create project
3. Push code to GitHub and connect repo, or run `railway up`
4. Set `DATABASE_URL` variable to reference the Postgres service

## Project Structure

```
├── src/
│   └── index.js       # Express app entry point
├── railway.json       # Railway config-as-code
├── package.json       # Dependencies and scripts
├── .env.example       # Example environment variables
└── AGENTS.md          # This file
```
