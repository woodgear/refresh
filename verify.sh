#!/bin/bash
# radar 验收冒烟脚本（docs/design.md §10）。
# 隔离环境（临时 RADAR_DATA_DIR + mock fetcher + 独立端口）跑 curl 断言。
# 退出码 0 = 全绿。每次改动后必跑，作回归。
set -u
cd "$(dirname "$0")"

PORT=${VERIFY_PORT:-3210}
BASE="http://localhost:${PORT}/api/v1"
TMPDIR=$(mktemp -d /tmp/radar-verify-XXXXXX)
PASS=0
FAIL=0

log()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); log "  ok: $*"; }
fail() { FAIL=$((FAIL+1)); log "  FAIL: $*"; }

assert_eq() { # expected actual desc
  if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (expected=$1 actual=$2)"; fi
}

# ---------- 启动 server ----------
RADAR_DATA_DIR="$TMPDIR" RADAR_FETCHER=mock RADAR_SCHEDULER=off RADAR_AUTH_PRECHECK=off PORT=$PORT bun server/index.ts >"$TMPDIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$TMPDIR"' EXIT

for i in $(seq 1 50); do
  curl -sf "$BASE/accounts" >/dev/null 2>&1 && break
  sleep 0.2
done
if ! curl -sf "$BASE/accounts" >/dev/null 2>&1; then
  log "FATAL: server did not start; log:"
  tail -20 "$TMPDIR/server.log"
  exit 1
fi

log "== A1: 资源 API 信封与 selector =="
assert_eq "AccountList" "$(curl -s "$BASE/accounts" | jq -r .kind)" "accounts 列表信封"
assert_eq "radar/v1"    "$(curl -s "$BASE/accounts" | jq -r '.items[0].apiVersion')" "Account apiVersion"
assert_eq "zhihu-main"  "$(curl -s "$BASE/accounts/zhihu-main" | jq -r .metadata.name)" "单资源 GET"
assert_eq "404"         "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/accounts/nope")" "未知资源 404"
assert_eq "400"         "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/messages?labelSelector=bad")" "非法 selector 400"
assert_eq "LogTail"     "$(curl -s "$BASE/logs" | jq -r .kind)" "日志 API 信封"
LOG_LINES=$(curl -s "$BASE/logs" | jq '.lines | length')
if [ "$LOG_LINES" -ge 1 ] 2>/dev/null; then ok "日志已落盘 ($LOG_LINES 行)"; else fail "日志为空"; fi

log "== A2(mock): POST refreshwindows → Succeeded，档案落盘 =="
WIN=$(curl -s -X POST "$BASE/refreshwindows" -d '{"spec":{"source":"zhihu-main-recommend","count":10,"trigger":"manual"}}')
WIN_NAME=$(echo "$WIN" | jq -r .metadata.name)
assert_eq "Pending" "$(echo "$WIN" | jq -r .status.phase)" "创建即返回 Pending"
for i in $(seq 1 30); do
  PHASE=$(curl -s "$BASE/refreshwindows/$WIN_NAME" | jq -r .status.phase)
  [ "$PHASE" = "Succeeded" ] || [ "$PHASE" = "Failed" ] && break
  sleep 0.2
done
assert_eq "Succeeded" "$PHASE" "window 走到 Succeeded"
assert_eq "3" "$(curl -s "$BASE/refreshwindows/$WIN_NAME" | jq -r .status.stats.new)" "stats.new 正确（广告丢弃、聚合卡拆开）"
if ls "$TMPDIR/windows/$WIN_NAME.json" >/dev/null 2>&1; then ok "档案落盘"; else fail "档案未落盘"; fi
# 同 source 再抓一轮 → 全部 duplicate
WIN2_NAME=$(curl -s -X POST "$BASE/refreshwindows" -d '{"spec":{"source":"zhihu-main-recommend"}}' | jq -r .metadata.name)
sleep 1
assert_eq "3" "$(curl -s "$BASE/refreshwindows/$WIN2_NAME" | jq -r .status.stats.duplicate)" "重复轮 stats.duplicate 正确"
assert_eq "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/refreshwindows" -d '{"spec":{"source":"nope"}}')" "未知 source 400"

log "== messages 查询 =="
curl -s -X POST "$BASE/refreshwindows" -d '{"spec":{"source":"twitter-main-following"}}' >/dev/null
sleep 1
assert_eq "5" "$(curl -s "$BASE/messages" | jq '.items | length')" "全量 messages = 5"
assert_eq "3" "$(curl -s "$BASE/messages?labelSelector=platform=zhihu" | jq '.items | length')" "labelSelector 过滤"
assert_eq "1" "$(curl -s "$BASE/messages?labelSelector=platform=zhihu&limit=1" | jq '.items | length')" "limit 生效"
assert_eq "zhihu-8003" "$(curl -s "$BASE/messages?labelSelector=platform=zhihu" | jq -r '.items[0].metadata.name')" "按时间倒序（聚合卡内条目正常入库）"
assert_eq "mock excerpt one" "$(curl -s "$BASE/messages/zhihu-8001" | jq -r .spec.text)" "单条 GET + normalize"
RAW_ID=$(curl -s "$BASE/messages/zhihu-8001" | jq -r .spec.raw.id)
assert_eq "8001" "$RAW_ID" "spec.raw 保留原始 payload"
# 多源归属：同一内容被第二个源推到后，两个源的视图里都应出现
curl -s -X POST "$BASE/refreshwindows" -d '{"spec":{"source":"zhihu-main-follow"}}' >/dev/null
sleep 1
assert_eq "3" "$(curl -s "$BASE/messages?labelSelector=source=zhihu-main-follow" | jq '.items | length')" "多源归属：后见源也能查到"
assert_eq "3" "$(curl -s "$BASE/messages?labelSelector=source=zhihu-main-recommend" | jq '.items | length')" "多源归属：首见源不受影响"
assert_eq "5" "$(curl -s "$BASE/messages" | jq '.items | length')" "多源归属不产生重复消息"

log "== A3/A4: created_at + 媒体本地化（mock GraphQL 链路） =="
TW=$(curl -s "$BASE/messages/twitter-9001")
assert_eq "2026-06-10T01:00:00.000Z" "$(echo "$TW" | jq -r .metadata.creationTimestamp)" "twitter created_at 解析"
assert_eq "mockuser" "$(echo "$TW" | jq -r .spec.author.handle)" "GraphQL 作者解析"
MEDIA_URL=$(echo "$TW" | jq -r '.spec.media[0].url')
case "$MEDIA_URL" in
  /api/v1/media/*) ok "media[0].url 已本地化 ($MEDIA_URL)" ;;
  *) fail "media[0].url 未本地化: $MEDIA_URL" ;;
esac
MEDIA_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}${MEDIA_URL}")
assert_eq "200" "$MEDIA_CODE" "GET /api/v1/media/{hash} 可访问"
MEDIA_TYPE=$(curl -s -o /dev/null -w '%{content_type}' "http://localhost:${PORT}${MEDIA_URL}")
assert_eq "image/png" "$MEDIA_TYPE" "媒体 content-type 正确"
AVATAR=$(echo "$TW" | jq -r .spec.author.avatar)
case "$AVATAR" in
  /api/v1/media/*) ok "头像已本地化" ;;
  *) fail "头像未本地化: $AVATAR" ;;
esac

log "== A9: author 归类地基 =="
assert_eq "2" "$(curl -s "$BASE/authors" | jq '.items | length')" "authors 注册表"
assert_eq "3" "$(curl -s "$BASE/authors/zhihu-mock-author" | jq -r .status.messageCount)" "messageCount 统计"
curl -s -X PATCH "$BASE/authors/zhihu-mock-author" -d '{"labels":{"category":"test-cat"}}' >/dev/null
assert_eq "test-cat" "$(curl -s "$BASE/authors/zhihu-mock-author" | jq -r .metadata.labels.category)" "PATCH author label（overlay）"
assert_eq "3" "$(curl -s "$BASE/messages?authorSelector=category=test-cat" | jq '.items | length')" "authorSelector 筛消息"
assert_eq "0" "$(curl -s "$BASE/messages?authorSelector=category=other" | jq '.items | length')" "authorSelector 不命中为空"
curl -s -X PATCH "$BASE/messages/zhihu-8001" -d '{"labels":{"starred":"true"}}' >/dev/null
assert_eq "true" "$(curl -s "$BASE/messages/zhihu-8001" | jq -r .metadata.labels.starred)" "PATCH message label（overlay）"

log "== A8(半自动): RSS 输出 =="
RSS_CODE=$(curl -s -o "$TMPDIR/feed.xml" -w '%{http_code}' "http://localhost:${PORT}/rss/zhihu-main-recommend.xml")
assert_eq "200" "$RSS_CODE" "RSS 200"
if command -v xmllint >/dev/null && xmllint --noout "$TMPDIR/feed.xml" 2>/dev/null; then ok "RSS 是合法 XML"; else fail "RSS XML 非法"; fi
if grep -q '<guid isPermaLink="false">zhihu-8001</guid>' "$TMPDIR/feed.xml"; then ok "guid = message name"; else fail "guid 缺失"; fi
assert_eq "404" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/rss/nope.xml")" "未知 feed 404"
curl -s "http://localhost:${PORT}/rss/all.xml" | xmllint --noout - 2>/dev/null && ok "all.xml 合法" || fail "all.xml 非法"
NAMES_COUNT=$(curl -s "$BASE/messages?names=zhihu-8001,twitter-9001,missing" | jq '.items | length')
assert_eq "2" "$NAMES_COUNT" "messages?names= 批量查询"

log "== A5(mock): 登录闭环（logged_out → LoginSession → Succeeded → 补抓） =="
PORT2=$((PORT+1))
BASE2="http://localhost:${PORT2}/api/v1"
TMPDIR2=$(mktemp -d /tmp/radar-verify-auth-XXXXXX)
RADAR_DATA_DIR="$TMPDIR2" RADAR_FETCHER=mock RADAR_AUTH_MOCK=logged_out RADAR_SCHEDULE_INTERVAL_MS=1000 PORT=$PORT2 bun server/index.ts >"$TMPDIR2/server.log" 2>&1 &
SERVER2_PID=$!
trap 'kill $SERVER_PID $SERVER2_PID 2>/dev/null; rm -rf "$TMPDIR" "$TMPDIR2"' EXIT
for i in $(seq 1 50); do curl -sf "$BASE2/accounts" >/dev/null 2>&1 && break; sleep 0.2; done

assert_eq "logged_out" "$(curl -s "$BASE2/accounts/zhihu-main?check=1" | jq -r .status.auth)" "登出态被检测"
LS=$(curl -s -X POST "$BASE2/loginsessions" -d '{"spec":{"account":"zhihu-main"}}')
LS_ID=$(echo "$LS" | jq -r .metadata.name)
assert_eq "WaitingScan" "$(echo "$LS" | jq -r .status.phase)" "LoginSession 进入 WaitingScan"
assert_eq "qr" "$(echo "$LS" | jq -r .spec.mode)" "知乎走 QR 模式"
QR_TYPE=$(curl -s -o /dev/null -w '%{content_type}' "$BASE2/loginsessions/$LS_ID/qr")
assert_eq "image/png" "$QR_TYPE" "QR 子资源返回 PNG"
curl -s "$BASE2/loginsessions/$LS_ID" >/dev/null
curl -s "$BASE2/loginsessions/$LS_ID" >/dev/null
assert_eq "Succeeded" "$(curl -s "$BASE2/loginsessions/$LS_ID" | jq -r .status.phase)" "轮询至 Succeeded"
assert_eq "ok" "$(curl -s "$BASE2/accounts/zhihu-main" | jq -r .status.auth)" "登录后 Account.status 翻转"
sleep 1.5
POST_LOGIN=$(curl -s "$BASE2/refreshwindows" | jq '[.items[] | select(.spec.trigger == "post-login")] | length')
assert_eq "2" "$POST_LOGIN" "登录成功自动补抓该账号全部源"
log "  (A6) 登出账号被调度器跳过：等 3 个调度周期…"
sleep 3
SCHED2=$(curl -s "$BASE2/refreshwindows" | jq '[.items[] | select(.spec.trigger == "scheduled" and (.spec.account == "twitter-main"))] | length')
assert_eq "0" "$SCHED2" "logged_out 账号无 scheduled window（twitter-main 未登录被跳过）"
kill $SERVER2_PID 2>/dev/null

log "== A6: 调度器（auth ok → 周期性 scheduled window） =="
PORT3=$((PORT+2))
BASE3="http://localhost:${PORT3}/api/v1"
TMPDIR3=$(mktemp -d /tmp/radar-verify-sched-XXXXXX)
RADAR_DATA_DIR="$TMPDIR3" RADAR_FETCHER=mock RADAR_AUTH_MOCK=ok RADAR_SCHEDULE_INTERVAL_MS=1000 PORT=$PORT3 bun server/index.ts >"$TMPDIR3/server.log" 2>&1 &
SERVER3_PID=$!
trap 'kill $SERVER_PID $SERVER2_PID $SERVER3_PID 2>/dev/null; rm -rf "$TMPDIR" "$TMPDIR2" "$TMPDIR3"' EXIT
for i in $(seq 1 50); do curl -sf "$BASE3/accounts" >/dev/null 2>&1 && break; sleep 0.2; done
sleep 10
SCHED3=$(curl -s "$BASE3/refreshwindows" | jq '[.items[] | select(.spec.trigger == "scheduled")] | length')
if [ "$SCHED3" -ge 4 ] 2>/dev/null; then ok "调度轮创建 scheduled windows ($SCHED3 个，覆盖 4 源)"; else fail "scheduled windows 不足: $SCHED3"; fi
SCHED_OK=$(curl -s "$BASE3/refreshwindows" | jq '[.items[] | select(.spec.trigger == "scheduled" and .status.phase == "Succeeded")] | length')
if [ "$SCHED_OK" -ge 4 ] 2>/dev/null; then ok "scheduled windows 走到 Succeeded ($SCHED_OK)"; else fail "Succeeded 的 scheduled windows 不足: $SCHED_OK"; fi
kill $SERVER3_PID 2>/dev/null

log "== 重启持久性：索引由档案+overlay 重建 =="
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
RADAR_DATA_DIR="$TMPDIR" RADAR_FETCHER=mock RADAR_SCHEDULER=off RADAR_AUTH_PRECHECK=off PORT=$PORT bun server/index.ts >>"$TMPDIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 50); do curl -sf "$BASE/accounts" >/dev/null 2>&1 && break; sleep 0.2; done
assert_eq "5" "$(curl -s "$BASE/messages" | jq '.items | length')" "重启后 messages 恢复"
assert_eq "test-cat" "$(curl -s "$BASE/authors/zhihu-mock-author" | jq -r .metadata.labels.category)" "重启后 overlay 保留"

log ""
log "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && { log "ALL GREEN"; exit 0; } || exit 1
