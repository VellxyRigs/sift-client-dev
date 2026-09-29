@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Sift Lite - Cloudflare Worker deploy + pool loader
echo ============================================================
echo.

where wrangler >nul 2>nul
if errorlevel 1 (
  echo [!] wrangler is not installed. Install Node.js, then run:
  echo     npm install -g wrangler
  echo.
  pause
  exit /b 1
)

echo [1/4] Checking Cloudflare login...
call wrangler whoami
if errorlevel 1 (
  echo.
  echo Not logged in. Opening browser login...
  call wrangler login
)

echo.
echo [2/4] Deploying the Worker...
call wrangler deploy
if errorlevel 1 ( echo [!] deploy failed & pause & exit /b 1 )

echo.
echo [3/4] Loading pool codes into KV (binding POOL, key "codes")...
if not exist pool-seed.json (
  echo [!] pool-seed.json not found - skipping. Create it with your code list.
) else (
  call wrangler kv key put --binding=POOL "codes" --path=pool-seed.json --remote
)

echo.
echo [4/4] PayPal secrets (press Enter to skip either one)...
set /p PPID="Paste PAYPAL_CLIENT_ID: "
if not "%PPID%"=="" ( echo.%PPID%| call wrangler secret put PAYPAL_CLIENT_ID )
set /p PPSEC="Paste PAYPAL_CLIENT_SECRET: "
if not "%PPSEC%"=="" ( echo.%PPSEC%| call wrangler secret put PAYPAL_CLIENT_SECRET )

echo.
echo Done. Set your Worker URL as grantService in index.html, then commit+push.
pause
