# Railway Deployment Guide for WhatsApp Analytics

This guide will help you deploy the WhatsApp Analytics application to Railway.

## Prerequisites

1. A [Railway](https://railway.app) account (sign up for free)
2. Your project code pushed to a Git repository (GitHub, GitLab, or Bitbucket)
3. Basic understanding of Railway platform

## Deployment Steps

### 1. Prepare Your Repository

Make sure your code is committed and pushed to your Git repository:

```bash
git add .
git commit -m "Prepare for Railway deployment"
git push origin main
```

### 2. Create a New Railway Project

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Click "New Project"
3. Select "Deploy from GitHub repo" (or your preferred Git provider)
4. Authenticate with your Git provider if needed
5. Select your WhatsApp Analytics repository
6. Railway will automatically detect your project and start deploying

### 3. Configure Environment Variables (Optional)

If you need custom configuration:

1. Go to your project in Railway Dashboard
2. Click on your service
3. Go to the "Variables" tab
4. Add any required environment variables:
   - `NODE_ENV=production` (automatically set by Railway)
   - `PORT` (automatically set by Railway)

### 4. Monitor the Build

1. Railway will automatically:
   - Install backend dependencies (`npm install`)
   - Build the frontend (`npm run railway:build`)
   - Start the server (`npm run railway:start`)

2. Watch the build logs in the "Deployments" tab
3. Wait for the deployment to complete (usually 3-5 minutes)

### 5. Access Your Application

1. Once deployed, Railway will provide you with a public URL
2. Click on the "Settings" tab
3. Scroll down to "Domains"
4. Copy your public domain (e.g., `your-app.up.railway.app`)
5. Open this URL in your browser

### 6. Authenticate WhatsApp

1. Navigate to `/login` on your deployed URL
2. Scan the QR code with your WhatsApp mobile app
3. Wait for authentication to complete
4. You'll be redirected to the main dashboard

### 7. Start Monitoring Groups

1. Add group names you want to monitor
2. The system will automatically start tracking messages and events
3. All data is stored in the SQLite database on Railway's persistent storage

## Important Notes

### Database Persistence

- Railway provides persistent storage for your SQLite database
- Your data will persist across deployments
- Database location: `/app/whatsapp_analytics.db`

### WhatsApp Session

- WhatsApp session is stored in `.wwebjs_auth` folder
- This persists across deployments on Railway
- If you logout, the session will be deleted and you'll need to re-authenticate

### Chromium/Puppeteer

- The `nixpacks.toml` file configures Chromium for WhatsApp Web.js
- No additional configuration needed - it works out of the box

### Logs and Debugging

To view logs:
1. Go to your Railway project
2. Click on your service
3. Go to the "Deployments" tab
4. Click on the latest deployment
5. View real-time logs

### Redeployment

Railway automatically redeploys when you push to your repository:

```bash
git add .
git commit -m "Update feature"
git push origin main
```

### Custom Domain (Optional)

To use a custom domain:
1. Go to "Settings" > "Domains" in your Railway service
2. Click "Add Custom Domain"
3. Follow the instructions to configure DNS

## Project Structure

```
whatsappAnalytics/
├── server.js                  # Backend server
├── package.json               # Backend dependencies & scripts
├── railway.json               # Railway configuration
├── nixpacks.toml              # Nixpacks configuration for Chromium
├── .railwayignore             # Files to exclude from deployment
├── config.json                # App configuration
├── whatsapp_analytics.db      # SQLite database
└── frontend/
    ├── package.json           # Frontend dependencies
    ├── vite.config.ts         # Vite configuration
    ├── dist/                  # Built frontend (created during build)
    └── src/                   # Frontend source code
```

## Configuration Files

### railway.json
Defines Railway-specific build and deploy commands:
- Build: `npm run railway:build`
- Start: `npm run railway:start`

### nixpacks.toml
Configures Chromium installation for WhatsApp Web.js (Puppeteer)

### .railwayignore
Excludes unnecessary files from deployment to reduce build size

## Troubleshooting

### Build Fails

**Problem**: Build fails with dependency errors

**Solution**:
- Check the build logs in Railway
- Ensure all dependencies are listed in `package.json`
- Try rebuilding: Click "Redeploy" in Railway

### WhatsApp Connection Issues

**Problem**: Can't connect to WhatsApp or QR code doesn't work

**Solution**:
- Check if Chromium installed correctly (view logs)
- Try logging out and logging back in
- Restart the service in Railway

### Application Not Loading

**Problem**: Getting 404 or blank page

**Solution**:
- Verify frontend was built correctly (check build logs)
- Ensure `frontend/dist` folder was created during build
- Check that `RAILWAY_ENVIRONMENT` variable is set

### Database Reset

**Problem**: Need to clear all data and start fresh

**Solution**:
- Use the Logout feature in the app (clears database)
- Or, delete the service and redeploy
- Or, access the Railway shell and delete the database file

## Environment Variables Reference

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Environment mode | `production` | No (auto-set) |
| `PORT` | Server port | `3000` | No (auto-set) |
| `RAILWAY_ENVIRONMENT` | Railway environment flag | auto-set | No (auto-set) |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Skip Puppeteer Chromium download | `true` | No (auto-set) |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium executable path | auto-set | No (auto-set) |

## Support

For issues related to:
- **Railway Platform**: [Railway Documentation](https://docs.railway.app)
- **WhatsApp Web.js**: [GitHub Issues](https://github.com/pedroslopez/whatsapp-web.js/issues)
- **This Application**: Contact your development team

## Cost Estimate

Railway offers:
- **Hobby Plan**: $5/month for 500 hours of usage
- **Free Trial**: $5 in credits (no credit card required)

Estimated usage for this app:
- ~$5-10/month depending on traffic and compute time

## Security Recommendations

1. **Never commit sensitive data** to your repository
2. **Use environment variables** for sensitive configuration
3. **Enable Railway's built-in authentication** if needed
4. **Keep your WhatsApp session secure** - don't share QR codes
5. **Regularly update dependencies** for security patches

## Maintenance

### Regular Tasks

1. **Monitor logs** weekly for errors
2. **Update dependencies** monthly
3. **Backup database** if storing critical data
4. **Review Railway usage** to manage costs

### Updates and Patches

To update the application:

```bash
# Pull latest changes
git pull origin main

# Install new dependencies (if any)
npm install
cd frontend && npm install && cd ..

# Test locally
npm run dev

# Deploy
git add .
git commit -m "Update application"
git push origin main
```

## Success Checklist

- [ ] Repository pushed to Git provider
- [ ] Railway project created and connected
- [ ] Build completed successfully
- [ ] Application accessible via public URL
- [ ] WhatsApp QR code scans successfully
- [ ] Can add groups and see messages
- [ ] Database persists data correctly
- [ ] Logout and re-authentication works

---

**Congratulations!** Your WhatsApp Analytics application is now deployed on Railway and ready to use.
