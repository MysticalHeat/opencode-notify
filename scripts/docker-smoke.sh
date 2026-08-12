#!/usr/bin/env bash
set -euo pipefail

IMAGE="opencode-notify:smoke-$$"
VOL_NAME="smoke-data-$$"
CONTAINER="opencode-notify-smoke-$$"
PORT=13000

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker volume rm -f "$VOL_NAME" 2>/dev/null || true
  docker rmi -f "$IMAGE" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Docker Smoke Test ==="

echo "[1/6] Building image..."
docker build -t "$IMAGE" -f apps/server/Dockerfile .

echo "[2/6] Creating temp volume..."
docker volume create "$VOL_NAME"

echo "[3/6] Starting container in fake Telegram mode..."
docker run -d --name "$CONTAINER" \
  --init \
  -v "$VOL_NAME:/data" \
  -e TELEGRAM_BOT_TOKEN=FAKE \
  -e TELEGRAM_USER_ID=123456789 \
  -e PUBLIC_BASE_URL=https://relay.example.com \
  -e LOGGING_LEVEL=info \
  -p "$PORT:3000" \
  "$IMAGE"

echo "[4/6] Waiting for readiness..."
READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health/ready" >/dev/null 2>&1; then
    READY=true
    echo "  Server ready after ${i}s"
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "ERROR: Server did not become ready within 30s"
  docker logs "$CONTAINER"
  exit 1
fi

HEALTH=$(curl -sf "http://localhost:$PORT/health/ready")
if [ "$(echo "$HEALTH" | jq -r '.status')" != "ok" ]; then
  echo "ERROR: Health endpoint returned unexpected: $HEALTH"
  exit 1
fi
echo "  Health: $HEALTH"

echo "[5/6] Verifying graceful shutdown..."
SHUTDOWN_START=$(date +%s)
docker stop -t 10 "$CONTAINER"
SHUTDOWN_END=$(date +%s)
DURATION=$((SHUTDOWN_END - SHUTDOWN_START))

SHUTDOWN_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")
echo "  Exit code: $SHUTDOWN_EXIT, duration: ${DURATION}s"

if [ "$SHUTDOWN_EXIT" != "0" ]; then
  echo "ERROR: Non-zero exit code: $SHUTDOWN_EXIT"
  docker logs "$CONTAINER"
  exit 1
fi

if [ "$DURATION" -gt 8 ]; then
  echo "WARNING: Shutdown took > 8s (${DURATION}s)"
fi

echo "[6/6] Verifying restart with the persisted volume..."
docker start "$CONTAINER"
READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health/ready" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "ERROR: Server did not restart with persisted data"
  docker logs "$CONTAINER"
  exit 1
fi

docker stop -t 10 "$CONTAINER"
docker rm "$CONTAINER"
docker volume rm "$VOL_NAME"

echo "=== Smoke test PASSED ==="
