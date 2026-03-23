#!/bin/bash
set -e
cd "$(dirname "$0")"

# Default count, can be overridden by first argument
COUNT=${1:-50}
COUNT=$(python3 -c "print(min(200, max(10, $COUNT)))")

TIMESTAMP=$(date +%s)

echo "Fetching data (count: ${COUNT})..."

echo "Fetching zhihu/follow..."
bb-browser site zhihu/follow $COUNT --jq '.' > "data/zhihu-follow-${TIMESTAMP}.json"

echo "Fetching zhihu/recommend..."
bb-browser site zhihu/recommend $COUNT --jq '.' > "data/zhihu-recommend-${TIMESTAMP}.json"

echo "Fetching twitter/following..."
bb-browser site twitter/following $COUNT --jq '.' > "data/twitter-following-${TIMESTAMP}.json"

echo "Fetching twitter/recommend..."
bb-browser site twitter/recommend $COUNT --jq '.' > "data/twitter-recommend-${TIMESTAMP}.json"

echo "Done!"
ls -la data/
