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
rotation_base_gateway=ed8b414868611caec5d34e1cf6821e4a96df82fc4062c1363d9d15118762bc48
rotation_gateway=d2d25a820a2d36c655d583823768efad297eae3c245cc9cdd11ddb1de169fd7c
request_gateway=f704a7e1bd1812efa0e8b9756f28c051b55804a1330b8e96e8e9418a50f678fd
random_gateway=4d35b8670c6e5619521ffff2a7831316c79657cd97a651662820d715e4a4d675
multi_source_gateway=09a2f43ac96ad5cdcb5bbb5ab3f6fd17bfa6233ebdcb5ecd5548a62aa5674583
multi_source_legacy_gateway=3c76fc1c1355b1118bfdd1fb2371c455a0d40f1548178835af68ac8699c39c97
live_recording_base=cc219eb14a15bce3f7178a07557e0cda1286047c0441709c05b60ea4c29b1060
live_recording_gateway=c364ebcf7dc5d413021376901fc0249ed85478bed21adda8446c90321753be92
recording_gateway=d27a45164810fddb9657a53ea68af29bf07cc85a7d99e7056b256ad95daac9ae
live_guest_playlists_gateway=b68e27c5df193c8ca7698633ad28a43816cb7e8681963afb52ad87b871348300
guest_playlists_gateway=618ba418456578531776ed583e7ddfbc1e500fdaf2cb9105bd24ed94bed8fcc9
exec 9>/opt/chat-server-music-deploy.lock
flock -n 9

actual_gateway=$(sha256sum "$install_dir/server.mjs" | awk '{print $1}')
reliability_base=633f0946a4058562a69b837e16998d69d36c2b08a697020045222415ec3ec077
reliability_gateway=8105075b69ec202b779ed5866f2e30a50e8f275161e6294b3d3de19a9e5f0f0c
current_release=false
if [[ "$actual_gateway" == "$reliability_base" || "$actual_gateway" == "$reliability_gateway" ]]; then
  current_release=true
fi
modern_gateway=$current_release
case "$actual_gateway" in
  "$multi_source_legacy_gateway"|"$live_recording_base"|"$live_recording_gateway"|"$recording_gateway"|"$live_guest_playlists_gateway"|"$guest_playlists_gateway")
    modern_gateway=true ;;
esac
if [[ "$modern_gateway" == false && "$actual_gateway" != "$original_gateway" && "$actual_gateway" != "$integrated_gateway" && "$actual_gateway" != "$observer_gateway" && "$actual_gateway" != "$explicit_fallback_gateway" && "$actual_gateway" != "$matrix_gateway" && "$actual_gateway" != "$matrix_fallback_gateway" && "$actual_gateway" != "$rotation_base_gateway" && "$actual_gateway" != "$rotation_gateway" && "$actual_gateway" != "$request_gateway" && "$actual_gateway" != "$random_gateway" && "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
  echo "Gateway version changed. Rebase the integration patch before deployment." >&2
  exit 1
fi

if [[ "$actual_gateway" == "$rotation_base_gateway" ]]; then
  (
    cd "$install_dir/src/music"
    sha256sum --check --status <<'EOF'
6afbf2442db5e05fa703024bd80871669d581fd30a42c5493cce3793623a046b  music-manager.mjs
97346773ad19b911e0a4f7f53b78f8802775f229a45df9ed699c1df0abe07fc3  qq-music.mjs
f1877f5704b189d4844cd68da9a44cf907dbca393424b566950650398940f528  registry.mjs
EOF
  ) || { echo "Live music modules changed. Rebase the rotation release before deployment." >&2; exit 1; }
fi

candidate=$(mktemp -d /tmp/chat-music-candidate.XXXXXXXX)
trap 'rm -rf -- "$candidate"' EXIT
cp -p "$install_dir/server.mjs" "$candidate/server.mjs"
cp -a "$release_dir/src" "$candidate/src"
if [[ "$modern_gateway" == true || "$actual_gateway" == "$rotation_base_gateway" || "$actual_gateway" == "$rotation_gateway" || "$actual_gateway" == "$request_gateway" || "$actual_gateway" == "$random_gateway" || "$actual_gateway" == "$multi_source_gateway" || "$actual_gateway" == "$multi_source_legacy_gateway" ]]; then
  # Use the live audio pipeline and replace only the modules changed by this release.
  music_files=(music-manager.mjs qq-music.mjs registry.mjs audio-source.mjs music-input.mjs catalog-providers.mjs provider-routing.mjs youtube-candidates.mjs)
  if [[ "$current_release" == true ]]; then
    music_files+=(stream-cache.mjs stream-signer.mjs stream-timeouts.mjs)
  fi
  cp -a "$install_dir/src/music/." "$candidate/src/music/"
  for name in "${music_files[@]}"; do
    cp -p "$release_dir/src/music/$name" "$candidate/src/music/$name"
  done
else
  music_files=()
  for file in "$candidate"/src/music/*.mjs; do music_files+=("$(basename "$file")"); done
fi
(
  cd "$candidate"
  if [[ "$current_release" == true ]]; then
    if [[ "$actual_gateway" == "$reliability_base" ]]; then
      git apply --check "$release_dir/music-reliability.patch"
      git apply "$release_dir/music-reliability.patch"
    fi
    [[ $(sha256sum server.mjs | cut -d' ' -f1) == "$reliability_gateway" ]]
  elif [[ "$modern_gateway" == false ]]; then
    if [[ "$actual_gateway" == "$original_gateway" ]]; then
      git apply --check "$release_dir/gateway-music.patch"
      git apply "$release_dir/gateway-music.patch"
    fi
    if [[ "$actual_gateway" == "$original_gateway" || "$actual_gateway" == "$integrated_gateway" ]]; then
      git apply --check "$release_dir/observer-id.patch"
      git apply "$release_dir/observer-id.patch"
    fi
    if [[ "$actual_gateway" != "$explicit_fallback_gateway" && "$actual_gateway" != "$matrix_fallback_gateway" && "$actual_gateway" != "$rotation_base_gateway" && "$actual_gateway" != "$rotation_gateway" && "$actual_gateway" != "$request_gateway" && "$actual_gateway" != "$random_gateway" && "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/explicit-fallback.patch"
      git apply "$release_dir/explicit-fallback.patch"
    fi
    if [[ "$actual_gateway" != "$rotation_gateway" && "$actual_gateway" != "$request_gateway" && "$actual_gateway" != "$random_gateway" && "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/rotation-fallback.patch"
      git apply "$release_dir/rotation-fallback.patch"
      if [[ "$actual_gateway" == "$rotation_base_gateway" ]]; then
        [[ $(sha256sum server.mjs | awk '{print $1}') == "$rotation_gateway" ]]
      fi
    fi
    if [[ "$actual_gateway" != "$request_gateway" && "$actual_gateway" != "$random_gateway" && "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/request-fallback.patch"
      git apply "$release_dir/request-fallback.patch"
      if [[ "$actual_gateway" == "$rotation_base_gateway" || "$actual_gateway" == "$rotation_gateway" ]]; then
        [[ $(sha256sum server.mjs | awk '{print $1}') == "$request_gateway" ]]
      fi
    fi
    if [[ "$actual_gateway" != "$random_gateway" && "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/random-request.patch"
      git apply "$release_dir/random-request.patch"
      [[ $(sha256sum server.mjs | awk '{print $1}') == "$random_gateway" ]]
    fi
    if [[ "$actual_gateway" != "$multi_source_gateway" && "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/multi-source.patch"
      git apply "$release_dir/multi-source.patch"
      [[ $(sha256sum server.mjs | awk '{print $1}') == "$multi_source_gateway" ]]
    fi
    if [[ "$actual_gateway" != "$multi_source_legacy_gateway" ]]; then
      git apply --check "$release_dir/multi-source-legacy.patch"
      git apply "$release_dir/multi-source-legacy.patch"
      [[ $(sha256sum server.mjs | awk '{print $1}') == "$multi_source_legacy_gateway" ]]
    fi
  fi
  if [[ "$current_release" == false && "$actual_gateway" != "$live_recording_gateway" && "$actual_gateway" != "$recording_gateway" && "$actual_gateway" != "$live_guest_playlists_gateway" && "$actual_gateway" != "$guest_playlists_gateway" ]]; then
    git apply --check "$release_dir/recording-match.patch"
    git apply "$release_dir/recording-match.patch"
    expected_recording_gateway=$recording_gateway
    if [[ "$actual_gateway" == "$live_recording_base" ]]; then expected_recording_gateway=$live_recording_gateway; fi
    [[ $(sha256sum server.mjs | awk '{print $1}') == "$expected_recording_gateway" ]]
  fi
  if [[ "$current_release" == false && "$actual_gateway" != "$live_guest_playlists_gateway" && "$actual_gateway" != "$guest_playlists_gateway" ]]; then
    git apply --check "$release_dir/guest-playlists.patch"
    git apply "$release_dir/guest-playlists.patch"
    expected_guest_gateway=$guest_playlists_gateway
    if [[ "$actual_gateway" == "$live_recording_base" || "$actual_gateway" == "$live_recording_gateway" ]]; then
      expected_guest_gateway=$live_guest_playlists_gateway
    fi
    [[ $(sha256sum server.mjs | awk '{print $1}') == "$expected_guest_gateway" ]]
  fi
  node --check server.mjs
  for file in src/music/*.mjs; do node --check "$file"; done
)
if [[ "$current_release" == true ]]; then
  # Reject unreviewed hotfixes, including changes made after an earlier --check.
  while read -r baseline name; do
    installed=$(sha256sum "$install_dir/$name" | cut -d' ' -f1)
    desired=$(sha256sum "$release_dir/$name" | cut -d' ' -f1)
    if [[ "$installed" != "$baseline" && "$installed" != "$desired" ]]; then
      echo "Live module changed: $name" >&2
      exit 1
    fi
  done <<'EOF'
774cffc55044d458a385ce3d97e1c616294353134a6788dfce94fafea2550f5e  src/music/audio-source.mjs
557560b200a386c4454ac79715fa7ea985245def37ae69dd742d1ae103c506e7  src/music/catalog-providers.mjs
bc555720af477535bcc90626992dc61b9069862fa63f89b84fa5df243f9b7f55  src/music/music-input.mjs
0e83493b20e3bece9256b1e20c31a7695e648f70f68e37ffd3fc9e1b8b9bc16f  src/music/music-manager.mjs
9ab2eaef203a310f53a22c09b681f4f1822964f23cbcdbe90ac0b7451632b357  src/music/provider-routing.mjs
19884ae43118a0ea424e40fa330f635c9fcab9a5eeffe25e0d059a9d419843ea  src/music/qq-music.mjs
d59e4fb2d3db60da5ebce920ac05b34858b7e5c5a4b0fde3dfb1dafca01b0bfc  src/music/registry.mjs
eb01ab315729726f9dac9a65e55ebb4136deb96281da0ead0a020e8ead6ac5f1  src/music/stream-cache.mjs
313afcc5f408add8cd936d41abc258284960fa2417589d15b1ead3c4254e7c2a  src/music/stream-signer.mjs
28108dd7a1713ce8a52218aa38f2b5edb7d6f08c1ee98c36a1d03cab61938a58  src/music/stream-timeouts.mjs
265aa228361fc4586e5c59bebf0ba7d6eca58fb23228ff94d75b88edf90f5b0b  src/music/youtube-candidates.mjs
d422bbd8fac99044060373b536e0526b374bfab31b01b1e87f80134416b6c92a  src/db/database.mjs
EOF
fi
cp -a "$release_dir/test" "$candidate/test"
(cd "$candidate" && CHAT_MUSIC_CACHE_DIR="$candidate/audio-cache" node --test test/music.test.mjs)
if [[ "$1" == "--check" ]]; then
  echo "Candidate checked. No running files changed."
  exit 0
fi

backup=$(mktemp -d "$install_dir/.music-release.XXXXXXXX")
echo "Rollback copy: $backup"
cp -p "$install_dir/server.mjs" "$backup/server.mjs"
cp -a "$install_dir/src/music" "$backup/music"
if [[ "$current_release" == true ]]; then
  cp -p "$install_dir/src/db/database.mjs" "$backup/database.mjs"
fi
if [[ "$actual_gateway" == "$original_gateway" ]]; then
  node "$release_dir/capture-playback.mjs" "$install_dir/data"
fi

rollback() {
  local status=$?
  trap - ERR INT TERM
  if [[ "$current_release" == true ]]; then
    cp -p "$backup/database.mjs" "$install_dir/src/db/database.mjs"
  fi
  cp -p "$backup/server.mjs" "$install_dir/server.mjs"
  for name in "${music_files[@]}"; do
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
if [[ "$current_release" == true ]]; then
  install -m 644 "$candidate/src/db/database.mjs" "$install_dir/src/db/database.mjs"
fi
for name in "${music_files[@]}"; do
  install -m 644 "$candidate/src/music/$name" "$install_dir/src/music/$name"
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
