#!/bin/bash
# Pet alone end to end against the fake OpenAI (test/fakechat.js). Run: bash test/petalone.sh [face.png]
cd "$(dirname "$0")/.."
FACE=${1:-../sketchylab/test/face.png}
fuser -k 3456/tcp 9999/tcp >/dev/null 2>&1; sleep 0.5
node test/fakechat.js "$FACE" > test/fake.log 2>&1 &
rm -rf /tmp/sketchy-pet
DATA_DIR=/tmp/sketchy-pet OPENAI_BASE=http://localhost:9999 OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3456 node server/index.js > test/srv.log 2>&1 &
sleep 2; FACE="$FACE" python3 test/petalone.py; r=$?; fuser -k 3456/tcp 9999/tcp >/dev/null 2>&1; exit $r
