@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ==========================================================================
rem  PITUAH.iaf desktop notifications setup for Chrome, Edge and Firefox on Windows
rem
rem  Browsers block notifications on sites that aren't HTTPS. This sets the
rem  official browser policies that treat this one site as secure and allow
rem  its notifications. It changes nothing else.
rem
rem  Usage:  pituah-notifications-setup.cmd [address] [/remove] [/dry-run]
rem    address    The app's address, for example http://10.0.0.5:8080
rem    /remove    Undo the setup for that address
rem    /dry-run   Show what would change, without changing anything
rem
rem  Run as administrator to set up every user on this computer.
rem  Otherwise it sets up only the current user.
rem ==========================================================================

set "APP_URL=__APP_URL__"
set "MODE=install"
set "DRYRUN="

:args
if "%~1"=="" goto argsdone
if /i "%~1"=="/remove" (
  set "MODE=remove"
) else if /i "%~1"=="/dry-run" (
  set "DRYRUN=1"
) else if /i "%~1"=="/?" (
  goto usage
) else (
  set "APP_URL=%~1"
)
shift
goto args
:argsdone

if "!APP_URL!"=="__APP_URL__" set "APP_URL="
if not defined APP_URL (
  set /p "APP_URL=Enter the app's address, for example http://10.0.0.5:8080 : "
)
if "!APP_URL:~-1!"=="/" set "APP_URL=!APP_URL:~0,-1!"

rem Only a plain web address is accepted, so nothing else can reach the commands below.
rem A pipe would turn off delayed expansion, so the address goes through a file instead.
set "CHECKFILE=%TEMP%\pituah-notify-url-%RANDOM%.txt"
>"%CHECKFILE%" echo(!APP_URL!
findstr /r /i /x /c:"https*://[a-z0-9.-]*" /c:"https*://[a-z0-9.-]*:[0-9]*" "%CHECKFILE%" >nul
set "BADURL=!errorlevel!"
del "%CHECKFILE%" >nul 2>&1
if not "!BADURL!"=="0" (
  echo.
  echo The address "!APP_URL!" is not valid. Use the form http://server:8080
  echo It must not end with a path.
  set "EXITCODE=2"
  goto end
)
if /i "!APP_URL:~0,8!"=="https://" (
  echo.
  echo !APP_URL! already uses HTTPS, so no setup is needed.
  echo Just allow notifications when the browser asks.
  set "EXITCODE=0"
  goto end
)

set "ROOT=HKCU"
net session >nul 2>&1 && set "ROOT=HKLM"
if defined PITUAH_POLICY_ROOT set "ROOT=%PITUAH_POLICY_ROOT%"

echo.
if "%MODE%"=="install" (echo Setting up desktop notifications for !APP_URL!) else (echo Removing the setup for !APP_URL!)
if "%ROOT%"=="HKLM" (echo For: every user on this computer) else if "%ROOT%"=="HKCU" (echo For: the current user only. Run as administrator to set up everyone.) else (echo For: test location %ROOT%)
if defined DRYRUN echo Dry run: nothing will be changed.
echo.

set "EXITCODE=0"
for %%B in ("Microsoft\Edge" "Google\Chrome") do (
  for %%P in (OverrideSecurityRestrictionsOnInsecureOrigin NotificationsAllowedForUrls) do (
    call :%MODE% "%ROOT%\SOFTWARE\Policies\%%~B\%%P"
  )
)

rem Firefox: allow the site's notifications, and treat its host as secure.
call :%MODE% "%ROOT%\SOFTWARE\Policies\Mozilla\Firefox\Permissions\Notifications\Allow"
set "FFHOST=!APP_URL:*://=!"
for /f "delims=:" %%H in ("!FFHOST!") do set "FFHOST=%%H"
call :firefoxhosts

echo.
if "%EXITCODE%"=="0" (
  if "%MODE%"=="install" (
    echo Done. Close every Chrome, Edge and Firefox window, open the app again, and turn on
    echo desktop notifications from your name in the sidebar.
    echo To check: open edge://policy, chrome://policy or about:policies in Firefox.
  ) else (
    echo Done. Restart Chrome, Edge and Firefox for this to take effect.
  )
) else (
  echo Something went wrong. Try again as administrator, or ask your IT team.
)
goto end

rem --------------------------------------------------------------------------
rem  Adds the address to a browser list policy, unless it is already there.
rem  List entries are values named 1, 2, 3 ... so existing entries are kept.
:install
set "KEY=%~1"
set "FOUND="
set "FREE="
for /L %%N in (1,1,200) do call :probe "%KEY%" %%N
if defined FOUND (
  echo   Already set: %KEY%
  exit /b 0
)
if defined DRYRUN (
  echo   Would run: reg add "%KEY%" /v !FREE! /t REG_SZ /d "!APP_URL!" /f
  exit /b 0
)
reg add "%KEY%" /v !FREE! /t REG_SZ /d "!APP_URL!" /f >nul 2>&1
if errorlevel 1 (
  echo   FAILED: %KEY%
  set "EXITCODE=1"
) else (
  echo   Added: %KEY%
)
exit /b 0

:remove
set "KEY=%~1"
set "FOUND="
set "FREE="
for /L %%N in (1,1,200) do call :probe "%KEY%" %%N
if not defined FOUND (
  echo   Not set: %KEY%
  exit /b 0
)
if defined DRYRUN (
  echo   Would run: reg delete "%KEY%" /v !FOUND! /f
  exit /b 0
)
reg delete "%KEY%" /v !FOUND! /f >nul 2>&1
if errorlevel 1 (
  echo   FAILED: %KEY%
  set "EXITCODE=1"
) else (
  echo   Removed: %KEY%
)
exit /b 0

rem  Adds or removes this site's host in Firefox's list of hosts treated as secure
rem  (the dom.securecontext.allowlist preference), keeping any other hosts in it.
:firefoxhosts
set "FFKEY=%ROOT%\SOFTWARE\Policies\Mozilla\Firefox"
set "PKEY=%FFKEY%\Preferences\dom.securecontext.allowlist"
reg query "%FFKEY%" /v Preferences >nul 2>&1
if not errorlevel 1 (
  echo   Skipped: your IT team already sets Firefox preferences in %FFKEY%.
  echo   Ask them to add !FFHOST! to dom.securecontext.allowlist.
  exit /b 0
)
set "HOSTS="
for /f "tokens=2,*" %%A in ('reg query "%PKEY%" /v Value 2^>nul ^| findstr /c:"REG_SZ"') do set "HOSTS=%%B"
set "NEWHOSTS="
set "HAD="
for %%H in (!HOSTS!) do (
  if /i "%%H"=="!FFHOST!" (set "HAD=1") else (
    if defined NEWHOSTS (set "NEWHOSTS=!NEWHOSTS!,%%H") else (set "NEWHOSTS=%%H")
  )
)
if "%MODE%"=="install" (
  if defined HAD (
    echo   Already set: %PKEY%
    exit /b 0
  )
  if defined NEWHOSTS (set "NEWHOSTS=!NEWHOSTS!,!FFHOST!") else (set "NEWHOSTS=!FFHOST!")
) else (
  if not defined HAD (
    echo   Not set: %PKEY%
    exit /b 0
  )
)
if defined DRYRUN (
  if defined NEWHOSTS (echo   Would set: %PKEY% Value = !NEWHOSTS!) else (echo   Would delete: %PKEY%)
  exit /b 0
)
set "RC=0"
if defined NEWHOSTS (
  reg add "%PKEY%" /v Value /t REG_SZ /d "!NEWHOSTS!" /f >nul 2>&1 || set "RC=1"
  reg add "%PKEY%" /v Status /t REG_SZ /d locked /f >nul 2>&1 || set "RC=1"
) else (
  reg delete "%PKEY%" /f >nul 2>&1 || set "RC=1"
)
if "!RC!"=="1" (
  echo   FAILED: %PKEY%
  set "EXITCODE=1"
) else (
  if defined NEWHOSTS (echo   Updated: %PKEY%) else (echo   Removed: %PKEY%)
)
exit /b 0

rem  Records the first unused entry number, and the entry that already holds this address.
:probe
if defined FOUND exit /b 0
reg query "%~1" /v %2 >nul 2>&1
if errorlevel 1 (
  if not defined FREE set "FREE=%2"
  exit /b 0
)
for /f "tokens=2,*" %%A in ('reg query "%~1" /v %2 2^>nul ^| findstr /r /c:"REG_SZ"') do (
  if /i "%%B"=="!APP_URL!" set "FOUND=%2"
)
exit /b 0

:usage
echo Usage: %~nx0 [address] [/remove] [/dry-run]
echo   address    The app's address, for example http://10.0.0.5:8080
echo   /remove    Undo the setup for that address
echo   /dry-run   Show what would change, without changing anything
set "EXITCODE=0"

:end
if not defined PITUAH_NO_PAUSE (
  echo.
  pause
)
exit /b %EXITCODE%
