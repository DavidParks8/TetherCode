#!/bin/sh

mode="${TETHERCODE_FAKE_BACKEND_MODE:-normal}"

request_id() {
  value=${1#*\"id\":}
  value=${value%%,*}
  value=${value%%\}*}
  printf '%s' "$value"
}

while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"serverInfo":{"name":"tethercode-fake"}}}\n' "$id"
      ;;
    *'"method":"thread/read"'*)
      if [ "$mode" = "death-on-thread-read" ]; then
        exit 42
      fi
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"thread":{"id":"thread-1","turns":[]}}}\n' "$id"
      ;;
    *'"method":"turn/start"'*)
      if [ "$mode" = "hang-turn-start" ]; then
        continue
      fi
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"turn":{"id":"turn-fake"}}}\n' "$id"
      ;;
    *'"method":"account/read"'*)
      if [ "$mode" = "death-on-account-read" ]; then
        exit 42
      fi
      if [ "$mode" = "hang-account-read" ]; then
        continue
      fi
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"account":null}}\n' "$id"
      ;;
    *'"id":'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
