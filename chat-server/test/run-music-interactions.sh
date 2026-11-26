#!/usr/bin/env bash
# On the VPS, use a fresh mount and network namespace. Production files stay outside the test.
set -Eeuo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
candidate=$(mktemp -d /tmp/jukebox-interactions.XXXXXXXX)
trap 'rm -rf -- "$candidate"' EXIT
cp -a /opt/chat-server/{server.mjs,src,node_modules} "$candidate/"
cp "$root"/src/music/*.mjs "$candidate/src/music/"
cp "$root"/test/{interaction,interaction-fixture}.mjs "$candidate/"
(
  cd "$candidate"
  if git apply --check "$root/gateway-music-card.patch" 2>/dev/null; then
    git apply "$root/gateway-music-card.patch"
  else
    git apply --reverse --check "$root/gateway-music-card.patch"
  fi
  sed -i -E "s/^(const [A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]* = ).*;/\1'fixture';/" server.mjs
  cat >fixture-downloader <<'DOWNLOADER'
#!/usr/bin/env bash
set -eu
while [[ "$1" != "-o" ]]; do shift; done
out=$2
url=$3
echo "${url##*=}" >>downloader.log
echo "$(date +%s%3N) start ${url##*=}" >>downloader-times.log
trap 'echo "$(date +%s%3N) end ${url##*=}" >>downloader-times.log' EXIT
sleep 0.8
cp fixture.mp3 "$out"
DOWNLOADER
  chmod 700 fixture-downloader
  mkdir data
  touch .env
  ffmpeg -nostdin -loglevel error -f lavfi -i sine=frequency=440:duration=210 -b:a 256k fixture.mp3
)
unshare --mount --net --propagation private bash -eu -c '
  mount --bind "$1" /opt/chat-server
  cd /opt/chat-server
  ip link set lo up
  export YTDLP_PATH="$PWD/fixture-downloader"
  export CHAT_INTERACTION_FIXTURE=1 FIXTURE_CHUNK_MS=16
  export CHAT_MUSIC_CACHE_DIR="$PWD/data/music_cache" CHAT_SHARED_MUSIC_DIR="$PWD/data/shared_music"
  exec timeout 80s nice -n 10 node interaction.mjs
' bash "$candidate"
