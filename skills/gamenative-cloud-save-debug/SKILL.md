---
name: gamenative-cloud-save-debug
description: Investigate why a game's cloud saves are not loading correctly in GameNative. Covers ADB filesystem inspection, Steam cloud file comparison, UFS pattern analysis, IS cache path tracing, DB state inspection, and code-level root cause identification. Use when a user reports that saves "look downloaded but the game starts fresh", progress is missing, or a specific game's save sync appears broken.
---

# GameNative Cloud Save Debug

Use this skill when the user reports:
- Cloud saves downloaded but game starts with no progress
- A specific game shows blank/fresh state despite having Steam cloud saves
- Save files appear in the wrong location or the game can't find them
- Save sync looks like it completed but the game ignores it

## Requirements

- `adb` connected device with `run-as app.gamenative` access
- GameNative repo checked out at `/Users/kurt/Developer/GameNative`
- `sqlite3` available on the Mac (for DB inspection via pull-edit-push)
- `latchkey` with Discord credentials (optional, for Discord correlation)
- `python3` available on the Mac

## Key Paths Reference

All paths below live inside the GN app data on device. The per-game Wine
container is at:
```
/data/data/app.gamenative/files/imagefs/home/xuser-STEAM_{appId}/
```

| Purpose | Path (relative to container root) |
|---|---|
| Wine prefix | `.wine/` |
| WinAppDataRoaming | `.wine/drive_c/users/xuser/AppData/Roaming/` |
| WinAppDataLocal | `.wine/drive_c/users/xuser/AppData/Local/` |
| WinAppDataLocalLow | `.wine/drive_c/users/xuser/AppData/LocalLow/` |
| ISteamRemoteStorage cache | `.wine/drive_c/Program Files (x86)/Steam/userdata/{accountId}/{appId}/remote/` |
| GSE legacy IS cache | `.wine/drive_c/users/xuser/AppData/Roaming/GSE Saves/{appId}/remote/` |
| steam_settings | `.wine/drive_c/Program Files (x86)/Steam/steam_settings/` |
| Game install (symlink) | `.wine/drive_c/Program Files (x86)/Steam/steamapps/common/{gameName}/` |
| Game install (actual, external) | `/storage/{sdcard}/Android/data/app.gamenative/files/Steam/steamapps/common/{gameName}/` |

Game containers use the Steam AppID as the suffix. Look up AppIDs on SteamDB.

## GN Database

The DB lives at `/data/data/app.gamenative/databases/pluvia.db`.
`sqlite3` is not available on the device so pull it to the Mac:
```bash
adb shell "run-as app.gamenative cp /data/data/app.gamenative/databases/pluvia.db /sdcard/Download/pluvia_debug.db"
adb pull /sdcard/Download/pluvia_debug.db /tmp/pluvia_debug.db
```

Relevant tables and columns:
```sql
-- Is the game marked as installed?
SELECT * FROM app_info WHERE id = {appId};
-- id | is_downloaded | downloaded_depots | dlc_depots | branch

-- Stored cloud change number (if matches cloud, no re-download)
SELECT * FROM app_change_numbers WHERE appId = {appId};
-- appId | changeNumber

-- Cached list of local files GN thinks it's tracking for this game
SELECT COUNT(*) FROM app_file_change_lists WHERE appId = {appId};
```

To clear VS state for a clean retest:
```bash
sqlite3 /tmp/pluvia_debug.db "
  DELETE FROM app_info WHERE id={appId};
  DELETE FROM app_change_numbers WHERE appId={appId};
  DELETE FROM app_file_change_lists WHERE appId={appId};
"
adb push /tmp/pluvia_debug.db /sdcard/Download/pluvia_debug.db
adb shell "run-as app.gamenative cp /sdcard/Download/pluvia_debug.db /data/data/app.gamenative/databases/pluvia.db"
adb shell "run-as app.gamenative rm -f /data/data/app.gamenative/databases/pluvia.db-wal /data/data/app.gamenative/databases/pluvia.db-shm"
```

## Workflow

### 1. Identify the game

Get the Steam AppID (SteamDB or `pm list packages` on device).
Confirm the container exists:
```bash
adb shell "run-as app.gamenative ls /data/data/app.gamenative/files/imagefs/home/" | grep {appId}
```

### 2. Get the Steam cloud file list

Have the user visit `https://store.steampowered.com/account/remotestorageapp/?appid={appId}`
and share a screenshot or describe the files. Note for each file:
- FOLDER (PathType: GameInstall, WinAppDataRoaming, WinAppDataLocalLow, etc.)
- FILE NAME (relative path + filename, including extension)
- FILE SIZE
- DATE WRITTEN

Files with **no FOLDER** shown in the UI were written via `ISteamRemoteStorage::FileWrite()`
and are IS files, not auto-cloud files — they need special handling (see section 5).

### 3. Check SteamDB UFS patterns

Look up the game on SteamDB → Cloud saves tab. Note:
- Each `root` (PathType)
- Each `path` (subdirectory)
- Each `pattern` (glob, e.g. `*.sav`, `*`, `*.dat`)
- Any `rootoverrides` (OS-specific path remaps)

**Critical check:** Do any cloud files have names that do NOT match the
game's own UFS glob patterns? E.g. a cloud file named `SaveData` (no
extension) when the pattern is `*.sav`. Those are IS files.

### 4. Compare cloud sizes with what's on device

For each cloud file, find its on-device counterpart:
```bash
# Auto-cloud file in WinAppDataRoaming
adb shell "run-as app.gamenative ls -la '{roaming_path}/{subdir}/'"

# IS file in IS cache
adb shell "run-as app.gamenative ls -la '{wine}/drive_c/Program Files (x86)/Steam/userdata/{accountId}/{appId}/remote/'"

# GameInstall file
adb shell "find /storage/ -path '*steamapps/common/{gameName}/{subpath}' 2>/dev/null"
```

Compare sizes:
- **Match** → file was downloaded correctly
- **Much smaller** (e.g. 3,450 B vs 26,397 B) → VS wrote a blank save because
  it couldn't find the real one; the download either failed or landed in the wrong place
- **Missing entirely** → download failed or went to a different path

### 5. Understand the two save mechanisms

GN handles two distinct types of cloud files differently:

**Auto-cloud files** — match the UFS `pattern` glob (e.g. `*.sav`):
- Downloaded to the UFS filesystem path based on their cloud prefix
  (e.g. `%WinAppDataRoaming%SomeGame/save.sav` → `Roaming/SomeGame/save.sav`)
- Scanned from the same path for upload detection
- Work correctly out of the box

**ISteamRemoteStorage (IS) files** — do NOT match the UFS `pattern` glob:
- Written by the game via `ISteamRemoteStorage::FileWrite("filename", data)`
- Appear in the AppFileChangeList under a UFS prefix, but the filename
  doesn't match the VDF glob (e.g. `SaveData` vs `*.sav`)
- Must be requested from Steam CDN by bare filename, not prefixed path
  (using the full prefixed path returns empty urlHost → silent skip)
- Must be routed to the IS cache (`userdata/{accountId}/{appId}/remote/`)
  so the GSE steam_api can serve them via `ISteamRemoteStorage::FileRead()`
- Require `local_save_path` in `configs.user.ini` to point the GSE to
  the same directory GN downloads to

If you see a game with IS files that aren't loading, this is the code
path to investigate in `SteamAutoCloud.kt`:
- `filenameMatchesUfsPattern()` — detects IS files
- `getFullFilePath()` — routes IS files to IS cache
- `downloadFiles()` — uses bare filename for IS file CDN requests
- `getLocalUserFilesAsPrefixMap()` — scans IS cache post-session for upload

And in `SteamUtils.kt`:
- `ensureSteamSettings()` — writes `[user::saves] / local_save_path`

### 6. Check configs.user.ini

```bash
adb shell "run-as app.gamenative cat '{wine}/drive_c/Program Files (x86)/Steam/steam_settings/configs.user.ini'"
```

Must contain:
```ini
[user::saves]
local_save_path=C:\Program Files (x86)\Steam\userdata\{accountId}
```

If missing, the GSE defaults to `GSE Saves/{appId}/remote/` — a different
directory from both the download destination and the IS cache.

### 7. Check configs.app.ini cloud_save dirs

```bash
adb shell "run-as app.gamenative cat '{wine}/drive_c/Program Files (x86)/Steam/steam_settings/configs.app.ini'"
```

Look for `[app::cloud_save::win]` — these tell the GSE which filesystem
directories to monitor. Verify the dirs match the game's actual UFS paths.

### 8. Run a clean sync test

To force a fresh full sync without deleting game files:
```bash
# Clear STEAM_DLL_REPLACED marker so ensureSteamSettings re-runs
adb shell "run-as app.gamenative find /data/data/app.gamenative/files/imagefs/home/xuser-STEAM_{appId} -name '.marker_STEAM_DLL_REPLACED' -delete 2>/dev/null"

# Clear change number and file cache from DB (forces full re-download)
# (use DB pull/edit/push method above)
sqlite3 /tmp/pluvia_debug.db "DELETE FROM app_change_numbers WHERE appId={appId}; DELETE FROM app_file_change_lists WHERE appId={appId};"
```

Then launch the game and watch logcat:
```bash
adb logcat -s SteamAutoCloud:V 2>&1 | grep -E "SaveData|IS.cache|URL host|cloudRoot|cloudPath|WinApp|SteamUser|isISFile"
```

Key log lines to look for:
- `GetAppFileListChange({appId})` — confirms sync started, lists files + prefixes
- `{filename} -> {actualFilePath}` — shows where each file is being routed
- `URL host of {prefixedPath} was empty` — IS file download being skipped
  (means bare filename not being used — check `filenameMatchesUfsPattern`)
- `Found IS-cache file ... cloudRoot=... cloudPath=...` — IS cache scan working

### 9. After launch checks

```bash
# IS cache — real save should match Steam cloud size
adb shell "run-as app.gamenative ls -la '{wine}/drive_c/Program Files (x86)/Steam/userdata/{accountId}/{appId}/remote/'"

# UFS Roaming path — auto-cloud saves
adb shell "run-as app.gamenative ls -la '{wine}/drive_c/users/xuser/AppData/Roaming/{gameSaveDir}/'"
```

If IS cache file size matches the Steam cloud size → download and routing work.
If it's tiny (a few KB) → game launched, found nothing, and wrote a blank save.

### 10. Wipe and reinstall for full end-to-end test

When you need to test the full flow as a new user would experience it:
```bash
adb shell am force-stop app.gamenative

# Wipe container
adb shell "run-as app.gamenative rm -rf /data/data/app.gamenative/files/imagefs/home/xuser-STEAM_{appId}"

# Wipe game files (adjust sdcard path for device)
adb shell "rm -rf '/storage/{sdcard}/Android/data/app.gamenative/files/Steam/steamapps/common/{gameName}'"
adb shell "rm -f '/storage/{sdcard}/Android/data/app.gamenative/files/Steam/steamapps/appmanifest_{appId}.acf'"

# Clear DB
# (pull DB, delete rows, push back as described in section above)
```

Then force-stop GN, reopen, download game, install DLC, Play.

## Common Patterns and Their Root Causes

| Symptom | Likely cause | Where to look |
|---|---|---|
| Game starts fresh every launch | IS file never downloaded; GSE can't find save | `filenameMatchesUfsPattern`, `downloadFiles` isISFile branch, IS cache path |
| Save downloaded but not read | IS file in UFS path, GSE reads from IS cache | `getFullFilePath` IS routing, `local_save_path` in configs.user.ini |
| "URL host … was empty" in log | IS file being requested with full prefix path, CDN returns nothing | `downloadFiles`: use bare filename for IS files |
| GN thinks game is installed but download button is gone | `app_info.is_downloaded=1` still set in DB despite files being deleted | Pull DB, DELETE FROM app_info WHERE id={appId} |
| Save loads old progress (2022 etc.) | Only auto-cloud `.sav` downloaded; IS file with real progress skipped | Check if cloud has a no-extension file not matching UFS glob |
| Conflict dialog every launch | Change number stored but IS cache file not tracked in file_change_list | `getLocalUserFilesAsPrefixMap` IS cache scan |

## Validated Games

| Game | AppID | IS file | Notes |
|---|---|---|---|
| Vampire Survivors | 1794680 | `SaveData` (no ext, under `%WinAppDataRoaming%Vampire_Survivors_{Steam3AccountID}/`) | UFS pattern `*.sav`; IS file fixed in `fix/is-remote-storage-save-sync` |

Add entries here as more games are validated.

## Relevant Source Files

| File | What it does |
|---|---|
| `app/src/main/java/app/gamenative/service/SteamAutoCloud.kt` | Full cloud sync: download, upload, IS file detection, IS cache scan |
| `app/src/main/java/app/gamenative/utils/SteamUtils.kt` | `ensureSteamSettings()` — writes configs.user.ini including local_save_path |
| `app/src/main/java/app/gamenative/utils/KeyValueUtils.kt` | Parses UFS VDF from Steam into `SaveFilePattern` objects |
| `app/src/main/java/app/gamenative/enums/PathType.kt` | Maps PathType enum values to actual Wine filesystem paths |
| `app/src/main/java/app/gamenative/data/SaveFilePattern.kt` | Data class: root, path, pattern, uploadRoot, uploadPath |
| `app/src/main/java/app/gamenative/data/UserFileInfo.kt` | Per-file tracking: root (local path), cloudRoot/cloudPath (upload prefix) |
| `app/src/main/java/app/gamenative/utils/FileUtils.kt` | `findFilesRecursive` — glob matching logic (split on `*`, contains check) |
