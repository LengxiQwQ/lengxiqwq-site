#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]] || [[ $1 != --check && $1 != --deploy ]]; then
  echo "Specify --check or --deploy." >&2
  exit 1
fi

release_dir=$(cd "$(dirname "$0")" && pwd)
install_dir=/opt/chat-server
original_gateway=7dedc85b56284e1141507c23e419a3c3d6065100592ff4201fb070492d8b70a1
integrated_gateway=79852271e948d9bd83dfa2cd0603605f7d0e07eaeb4d2c3e031bd7a09bbfb2cf
observer_gateway=bd12bd1d9b76b6a65ec4d64b72abed1c07fb550d6f724d4dcda07ce3362911ba
explicit_fallback_gateway=2d8a5c8ca9f3d89ccad9177e1f80581da6f0bd1f705eacab613952e0af4528fe
matrix_gateway=15e80a6902cf8d0f7ffcdd8b95782d2fc426f024821f95af52c9fafa23ebe5a1
matrix_fallback_gateway=723462d37191c4c6e0c6cbd2bb0b4576cb2d9d93d8676979cea2627059eca209
exec 9>/opt/chat-server-music-deploy.lock
flock -n 9

actual_gateway=$(sha256sum "$install_dir/server.mjs" | awk '{print $1}')
if [[ "$actual_gateway" != "$original_gateway" && "$actual_gateway" != "$integrated_gateway" && "$actual_gateway" != "$observer_gateway" && "$actual_gateway" != "$explicit_fallback_gateway" && "$actual_gateway" != "$matrix_gateway" && "$actual_gateway" != "$matrix_fallback_gateway" ]]; then
  echo "Gateway version changed. Rebase the integration patch before deployment." >&2
  exit 1
fi

candidate=$(mktemp -d /tmp/chat-music-candidate.XXXXXXXX)
cp -p "$install_dir/server.mjs" "$candidate/server.mjs"
cp -a "$release_dir/src" "$candidate/src"
(
  cd "$candidate"
  if [[ "$actual_gateway" == "$original_gateway" ]]; then
    git apply --check "$release_dir/gateway-music.patch"
    git apply "$release_dir/gateway-music.patch"
  fi
  if [[ "$actual_gateway" == "$original_gateway" || "$actual_gateway" == "$integrated_gateway" ]]; then
    git apply --check "$release_dir/observer-id.patch"
    git apply "$release_dir/observer-id.patch"
  fi
  if [[ "$actual_gateway" != "$explicit_fallback_gateway" && "$actual_gateway" != "$matrix_fallback_gateway" ]]; then
    git apply --check "$release_dir/explicit-fallback.patch"
    git apply "$release_dir/explicit-fallback.patch"
  fi
  node --check server.mjs
  for file in src/music/*.mjs; do node --check "$file"; done
)
node --test "$release_dir/test/music.test.mjs"
if [[ "$1" == "--check" ]]; then
  echo "Candidate checked. No running files changed."
  rm "$candidate/server.mjs"
  exit 0
fi

backup=$(mktemp -d "$install_dir/.music-release.XXXXXXXX")
echo "Rollback copy: $backup"
cp -p "$install_dir/server.mjs" "$backup/server.mjs"
cp -a "$install_dir/src/music" "$backup/music"
if [[ "$actual_gateway" == "$original_gateway" ]]; then
  node "$release_dir/capture-playback.mjs" "$install_dir/data"
fi

rollback() {
  local status=$?
  trap - ERR INT TERM
  cp -p "$backup/server.mjs" "$install_dir/server.mjs"
  for file in "$candidate"/src/music/*.mjs; do
    name=$(basename "$file")
    if [[ -f "$backup/music/$name" ]]; then
      cp -p "$backup/music/$name" "$install_dir/src/music/$name"
    else
      rm -f "$install_dir/src/music/$name"
    fi
  done
  pm2 restart chat-server
  echo "Gateway code restored from $backup" >&2
  exit "$((status == 0 ? 1 : status))"
}
trap rollback ERR INT TERM
for file in "$candidate"/src/music/*.mjs; do
  install -m 644 "$file" "$install_dir/src/music/$(basename "$file")"
done
# The gateway contains local production configuration. Retain its existing mode.
mv "$candidate/server.mjs" "$install_dir/server.mjs"
pm2 restart chat-server
healthy=false
for attempt in {1..15}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3001/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]]
trap - ERR INT TERM
echo "Music gateway is healthy. Rollback copy: $backup"
