#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/current-network.sh url
  scripts/current-network.sh env
  scripts/current-network.sh seed
  scripts/current-network.sh start

Environment:
  API_PORT=3035
  AUTH_PORT=3032
  API_HOST=<override detected host>
  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/game_platform
  REDIS_URL=redis://127.0.0.1:6379
  PRESENCE_REDIS_PREFIX=game-platform:presence
  PRESENCE_TTL_SECONDS=75
  AUTH_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/teddy_auth
  GAME_PLATFORM_SESSION_IDLE_SECONDS=2592000
  GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS=15552000
  GAME_PLATFORM_SESSION_MAX_AGE_SECONDS=604800
  GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS=604800
  GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS=3600
  GAME_PLATFORM_SESSION_ABANDON_DAYS=7
  GAME_PLATFORM_DISCONNECT_GRACE_SECONDS=60
  GENERATE_MAP=false

Notes:
  - seed registers both localhost and current-LAN OIDC callback URLs.
  - start runs the API on 0.0.0.0 with auth URLs that physical mobile devices can reach.
EOF
}

detect_default_interface() {
  route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}'
}

interface_ip() {
  local iface="$1"
  ifconfig "$iface" 2>/dev/null | awk '/inet /{print $2; exit}'
}

detect_host_ip() {
  if [[ -n "${API_HOST:-}" ]]; then
    printf '%s' "$API_HOST"
    return
  fi

  local iface
  iface="$(detect_default_interface || true)"
  if [[ -n "$iface" ]]; then
    local detected
    detected="$(interface_ip "$iface")"
    if [[ -z "$detected" ]]; then
      detected="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
    if [[ -n "$detected" ]]; then
      printf '%s' "$detected"
      return
    fi
  fi

  local fallback
  fallback="$(interface_ip en0)"
  if [[ -z "$fallback" ]]; then
    fallback="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [[ -n "$fallback" ]]; then
    printf '%s' "$fallback"
    return
  fi

  echo "Unable to detect current network IP. Set API_HOST." >&2
  exit 1
}

api_base_url() {
  local host
  host="$(detect_host_ip)"
  printf 'http://%s:%s/api' "$host" "${API_PORT:-3035}"
}

public_base_url() {
  local host
  host="$(detect_host_ip)"
  printf 'http://%s:%s' "$host" "${API_PORT:-3035}"
}

auth_base_url() {
  local host
  host="$(detect_host_ip)"
  printf 'http://%s:%s' "$host" "${AUTH_PORT:-3032}"
}

redirect_uri() {
  printf '%s/api/session/oidc/callback' "$(public_base_url)"
}

redirect_uris() {
  printf 'http://localhost:%s/api/session/oidc/callback,%s' "${API_PORT:-3035}" "$(redirect_uri)"
}

print_env() {
  cat <<EOF
PORT=${API_PORT:-3035}
HOST=0.0.0.0
NODE_ENV=${NODE_ENV:-}
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/game_platform}
REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379}
PRESENCE_REDIS_PREFIX=${PRESENCE_REDIS_PREFIX:-game-platform:presence}
PRESENCE_TTL_SECONDS=${PRESENCE_TTL_SECONDS:-75}
AUTH_DATABASE_URL=${AUTH_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/teddy_auth}
AUTH_ISSUER_URL=${AUTH_ISSUER_URL:-http://localhost:${AUTH_PORT:-3032}}
AUTH_API_BASE_URL=$(auth_base_url)
AUTH_JWKS_URL=${AUTH_JWKS_URL:-http://localhost:${AUTH_PORT:-3032}/oauth/jwks}
AUTH_AUDIENCE=${AUTH_AUDIENCE:-service:game-platform}
AUTH_SERVICE_KEY=${AUTH_SERVICE_KEY:-game-platform}
AUTH_DENIED_PERMISSIONS=${AUTH_DENIED_PERMISSIONS:-}
AUTH_SERVICE_KEY_ID=${AUTH_SERVICE_KEY_ID:-game-platform-local-service-key}
AUTH_SERVICE_SECRET=${AUTH_SERVICE_SECRET:-game-platform-local-service-secret}
GAME_PLATFORM_OIDC_CLIENT_ID=${GAME_PLATFORM_OIDC_CLIENT_ID:-game-platform-api}
GAME_PLATFORM_OIDC_CLIENT_SECRET=${GAME_PLATFORM_OIDC_CLIENT_SECRET:-game-platform-local-oidc-secret}
GAME_PLATFORM_OIDC_REDIRECT_URI=$(redirect_uri)
GAME_PLATFORM_OIDC_REDIRECT_URIS=$(redirect_uris)
GAME_PLATFORM_SESSION_IDLE_SECONDS=${GAME_PLATFORM_SESSION_IDLE_SECONDS:-2592000}
GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS=${GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS:-15552000}
GAME_PLATFORM_SESSION_MAX_AGE_SECONDS=${GAME_PLATFORM_SESSION_MAX_AGE_SECONDS:-604800}
GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS=${GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS:-604800}
GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS=${GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS:-3600}
GAME_PLATFORM_SESSION_COOKIE_NAME=${GAME_PLATFORM_SESSION_COOKIE_NAME:-game_platform_session}
GAME_PLATFORM_PUBLIC_BASE_URL=$(public_base_url)
GAME_PLATFORM_ALLOWED_RETURN_ORIGINS=$(public_base_url),gameplatform://auth/callback
GAME_PLATFORM_ALLOWED_RETURN_SCHEMES=${GAME_PLATFORM_ALLOWED_RETURN_SCHEMES:-gameplatform,gameplatform-dev}
GAME_PLATFORM_ALLOWED_ORIGINS=${GAME_PLATFORM_ALLOWED_ORIGINS:-http://localhost:3036,http://127.0.0.1:3036}
GENERATE_MAP=${GENERATE_MAP:-false}
GAME_PLATFORM_SESSION_ABANDON_DAYS=${GAME_PLATFORM_SESSION_ABANDON_DAYS:-7}
GAME_PLATFORM_DISCONNECT_GRACE_SECONDS=${GAME_PLATFORM_DISCONNECT_GRACE_SECONDS:-60}
EOF
}

seed_auth() {
  export AUTH_DATABASE_URL="${AUTH_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/teddy_auth}"
  export AUTH_SERVICE_KEY_ID="${AUTH_SERVICE_KEY_ID:-game-platform-local-service-key}"
  export AUTH_SERVICE_SECRET="${AUTH_SERVICE_SECRET:-game-platform-local-service-secret}"
  export GAME_PLATFORM_OIDC_CLIENT_SECRET="${GAME_PLATFORM_OIDC_CLIENT_SECRET:-game-platform-local-oidc-secret}"
  export GAME_PLATFORM_OIDC_REDIRECT_URIS="${GAME_PLATFORM_OIDC_REDIRECT_URIS:-$(redirect_uris)}"

  echo "GAME_PLATFORM_OIDC_REDIRECT_URIS=$GAME_PLATFORM_OIDC_REDIRECT_URIS"
  npm run seed:local-auth
}

start_api() {
  export PORT="${PORT:-${API_PORT:-3035}}"
  export HOST="${HOST:-0.0.0.0}"
  export NODE_ENV="${NODE_ENV:-}"
  export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/game_platform}"
  export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
  export PRESENCE_REDIS_PREFIX="${PRESENCE_REDIS_PREFIX:-game-platform:presence}"
  export PRESENCE_TTL_SECONDS="${PRESENCE_TTL_SECONDS:-75}"
  export AUTH_ISSUER_URL="${AUTH_ISSUER_URL:-http://localhost:${AUTH_PORT:-3032}}"
  export AUTH_API_BASE_URL="${AUTH_API_BASE_URL:-$(auth_base_url)}"
  export AUTH_JWKS_URL="${AUTH_JWKS_URL:-http://localhost:${AUTH_PORT:-3032}/oauth/jwks}"
  export AUTH_AUDIENCE="${AUTH_AUDIENCE:-service:game-platform}"
  export AUTH_SERVICE_KEY="${AUTH_SERVICE_KEY:-game-platform}"
  export AUTH_DENIED_PERMISSIONS="${AUTH_DENIED_PERMISSIONS:-}"
  export AUTH_SERVICE_KEY_ID="${AUTH_SERVICE_KEY_ID:-game-platform-local-service-key}"
  export AUTH_SERVICE_SECRET="${AUTH_SERVICE_SECRET:-game-platform-local-service-secret}"
  export GAME_PLATFORM_OIDC_CLIENT_ID="${GAME_PLATFORM_OIDC_CLIENT_ID:-game-platform-api}"
  export GAME_PLATFORM_OIDC_CLIENT_SECRET="${GAME_PLATFORM_OIDC_CLIENT_SECRET:-game-platform-local-oidc-secret}"
  export GAME_PLATFORM_OIDC_REDIRECT_URI="${GAME_PLATFORM_OIDC_REDIRECT_URI:-$(redirect_uri)}"
  export GAME_PLATFORM_SESSION_IDLE_SECONDS="${GAME_PLATFORM_SESSION_IDLE_SECONDS:-2592000}"
  export GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS="${GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS:-15552000}"
  export GAME_PLATFORM_SESSION_MAX_AGE_SECONDS="${GAME_PLATFORM_SESSION_MAX_AGE_SECONDS:-604800}"
  export GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS="${GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS:-604800}"
  export GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS="${GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS:-3600}"
  export GAME_PLATFORM_SESSION_COOKIE_NAME="${GAME_PLATFORM_SESSION_COOKIE_NAME:-game_platform_session}"
  export GAME_PLATFORM_PUBLIC_BASE_URL="${GAME_PLATFORM_PUBLIC_BASE_URL:-$(public_base_url)}"
  export GAME_PLATFORM_ALLOWED_RETURN_ORIGINS="${GAME_PLATFORM_ALLOWED_RETURN_ORIGINS:-$(public_base_url),gameplatform://auth/callback}"
  export GAME_PLATFORM_ALLOWED_RETURN_SCHEMES="${GAME_PLATFORM_ALLOWED_RETURN_SCHEMES:-gameplatform,gameplatform-dev}"
  export GAME_PLATFORM_ALLOWED_ORIGINS="${GAME_PLATFORM_ALLOWED_ORIGINS:-http://localhost:3036,http://127.0.0.1:3036}"
  export GENERATE_MAP="${GENERATE_MAP:-false}"
  export GAME_PLATFORM_SESSION_ABANDON_DAYS="${GAME_PLATFORM_SESSION_ABANDON_DAYS:-7}"
  export GAME_PLATFORM_DISCONNECT_GRACE_SECONDS="${GAME_PLATFORM_DISCONNECT_GRACE_SECONDS:-60}"

  echo "AUTH_API_BASE_URL=$AUTH_API_BASE_URL"
  echo "REDIS_URL=$REDIS_URL"
  echo "GAME_PLATFORM_OIDC_REDIRECT_URI=$GAME_PLATFORM_OIDC_REDIRECT_URI"
  npm run start:dev
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local command="$1"
  shift
  case "$command" in
    url)
      api_base_url
      printf '\n'
      ;;
    env)
      print_env
      ;;
    seed)
      seed_auth
      ;;
    start)
      start_api
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: $command" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
