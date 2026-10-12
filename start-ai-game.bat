@echo off
setlocal

REM =====================================================================
REM  The Beer Game (LA4) - one-click launcher for the AI proxy server
REM =====================================================================
REM  This does two things: starts ai-proxy-server in its own window (so
REM  it keeps running while you play), then opens index.html in your
REM  default browser a few seconds later. Double-click this file instead
REM  of typing the setup commands by hand each time.
REM
REM  You need your OpenAI key set up once before this will work - see
REM  below for the two ways to do that.
REM =====================================================================

REM ---- locate this script's own folder, so it works regardless of
REM      where the whole beer-game-ai-experiment folder was extracted ----
set SCRIPT_DIR=%~dp0

REM ---- PREFERRED: a .env file next to server.js ----
REM If ai-proxy-server\.env exists, the server loads it automatically -
REM nothing more to do here. See ai-proxy-server\.env.example for the
REM one-time setup: copy it to .env, fill in your real key there. This
REM keeps the key out of this .bat file entirely, which matters if you
REM ever share this folder with someone else.
if exist "%SCRIPT_DIR%ai-proxy-server\.env" goto :key_ready

REM ---- FALLBACK: a key set directly below, in this file ----
REM Only used if no .env exists. Replace only the placeholder text - do
REM not touch the quote marks or the OPENAI_API_KEY= part. The quotes
REM must wrap the WHOLE line, set "VAR=value", not just the value as
REM set VAR="value" - the second form embeds literal quote characters
REM into the key itself, which silently breaks the Authorization header.
REM Never share this file once a real key is filled in here - use the
REM .env method above instead if you might ever hand this folder to
REM someone else.
set "OPENAI_API_KEY=your-openai-api-key-here"

if not "%OPENAI_API_KEY%"=="your-openai-api-key-here" goto :key_ready

echo.
echo  ============================================================
echo   No OpenAI API key found. Two ways to fix this:
echo.
echo   Preferred: in the ai-proxy-server folder, copy .env.example
echo   to a new file named .env, then put your real key in that
echo   file. The server will pick it up automatically.
echo.
echo   Alternative: right-click this file, choose Edit, and replace
echo   "your-openai-api-key-here" near the top with your real key.
echo  ============================================================
echo.
pause
exit /b 1

:key_ready
if not exist "%SCRIPT_DIR%ai-proxy-server\server.js" (
    echo.
    echo  ============================================================
    echo   Could not find ai-proxy-server\server.js next to this file.
    echo   Make sure start-ai-game.bat stays inside the main
    echo   beer-game-ai-experiment folder, alongside index.html and
    echo   the ai-proxy-server folder - don't move it out on its own.
    echo  ============================================================
    echo.
    pause
    exit /b 1
)

echo Starting the AI proxy server in a new window...
REM pushd changes into the folder using batch's own quote handling, one
REM level of quoting only - this avoids the fragile nested-quote pattern
REM that "start ... cmd /k "cd /d "path" && ...."" would otherwise need,
REM which is a common source of mysterious failures in batch scripts.
pushd "%SCRIPT_DIR%ai-proxy-server"
start "Beer Game AI Proxy (leave this open while playing)" cmd /k "npm install && node server.js"
popd

echo Waiting a few seconds for it to come up...
timeout /t 4 /nobreak >nul

echo Opening the game...
start "" "%SCRIPT_DIR%index.html"

echo.
echo Done. The proxy is running in the other window - leave it open.
echo Closing that window will turn the AI suggestion feature off again.
echo.
pause
