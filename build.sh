#!/bin/bash
# build.sh —— 把 Electron 官方二进制包成 DSH 宿主 app（不需要 npm 安装）
set -eo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ELECTRON_APP"
if [ -z "$SRC" ]; then SRC="/tmp/electronout/Electron.app"; fi

# Electron 官方二进制不在本机时按需下载（不把 253M 常驻在仓库外）
if [ ! -d "$SRC" ]; then
  CACHE="$ROOT/Build/electron-cache"
  ZIP="$CACHE/electron-v45.3.3-darwin-arm64.zip"
  mkdir -p "$CACHE"
  if [ ! -f "$ZIP" ]; then
    echo "== 下载 Electron 45.3.3（约 115M）=="
    curl -fL --retry 2 --max-time 1800 -o "$ZIP" \
      "https://github.com/electron/electron/releases/download/v45.3.3/electron-v45.3.3-darwin-arm64.zip"
  fi
  if [ ! -d "$CACHE/unpacked/Electron.app" ]; then
    echo "== 解包 =="
    mkdir -p "$CACHE/unpacked"
    ditto -xk "$ZIP" "$CACHE/unpacked"
  fi
  SRC="$CACHE/unpacked/Electron.app"
fi
NAME="DSH Electron"
APP="$ROOT/Dist/$NAME.app"
EXE="DSHElectron"
BID="com.kaidiren.dsh-electron"

rm -rf "$APP"
mkdir -p "$ROOT/Dist"
ditto "$SRC" "$APP"

echo "== 主程序改名 =="
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$EXE"
P="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $EXE" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BID" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$P" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "$P" 2>/dev/null || true

echo "== helper 改名 =="
for suffix in "" " (GPU)" " (Renderer)" " (Plugin)"; do
  old="$APP/Contents/Frameworks/Electron Helper$suffix.app"
  new="$APP/Contents/Frameworks/$NAME Helper$suffix.app"
  [ -d "$old" ] || continue
  mv "$old" "$new"
  mv "$new/Contents/MacOS/Electron Helper$suffix" "$new/Contents/MacOS/$NAME Helper$suffix"
  hp="$new/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME Helper$suffix" "$hp"
  case "$suffix" in
    "")        sub="helper" ;;
    " (GPU)")  sub="helper.gpu" ;;
    " (Renderer)") sub="helper.renderer" ;;
    " (Plugin)")   sub="helper.plugin" ;;
  esac
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BID.$sub" "$hp"
done

echo "== 裁剪语言包（只留中英文）=="
FR="$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
if [ -d "$FR" ]; then
  for d in "$FR"/*.lproj; do
    [ -d "$d" ] || continue
    case "$(basename "$d")" in
      en.lproj|en_GB.lproj|zh_CN.lproj|zh_TW.lproj) ;;
      *) rm -rf "$d" ;;
    esac
  done
fi

echo "== 应用图标 =="
if [ -f "$ROOT/assets/AppIcon.icns" ]; then
  cp "$ROOT/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  rm -f "$APP/Contents/Resources/electron.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$P"
  echo "已应用 AppIcon.icns"
else
  echo "assets/AppIcon.icns 不存在，沿用 Electron 默认图标"
fi

echo "== 放入应用代码 =="
APPDIR="$APP/Contents/Resources/app"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/src" "$APPDIR/assets"
cp "$ROOT/package.json" "$APPDIR/package.json"
cp "$ROOT/src/main.js" "$APPDIR/src/main.js"
cp "$ROOT/src/service.js" "$APPDIR/src/service.js"
cp "$ROOT/src/overlay.html" "$APPDIR/src/overlay.html"
if [ -f "$ROOT/assets/trayTemplate@2x.png" ]; then
  cp "$ROOT/assets/trayTemplate@2x.png" "$APPDIR/assets/trayTemplate@2x.png"
fi
rm -f "$APP/Contents/Resources/default_app.asar"

echo "== 临时签名 =="
codesign --force --deep --sign - --timestamp=none "$APP" 2>/dev/null || \
  codesign --force --sign - --timestamp=none "$APP"

echo ""
echo "构建完成：$APP"
du -sh "$APP"
echo "framework: $(du -sh "$APP/Contents/Frameworks/Electron Framework.framework" | cut -f1)"
