#!/bin/sh
set -eu

: "${HOSTR_TOKEN:?Set HOSTR_TOKEN to your Hostr bearer token}"

path="${1:-brick-territories}"
case "$path" in
  ""|*[!a-zA-Z0-9/_-]*)
    echo "Path may only contain letters, numbers, slashes, underscores, and hyphens." >&2
    exit 1
    ;;
esac

npm run build -- --base ./

find dist -type f | while IFS= read -r file; do
  relative="${file#dist/}"
  case "$file" in
    *.css) content_type="text/css" ;;
    *.html) content_type="text/html" ;;
    *.js) content_type="text/javascript" ;;
    *.json) content_type="application/json" ;;
    *.mp3) content_type="audio/mpeg" ;;
    *.png) content_type="image/png" ;;
    *.svg) content_type="image/svg+xml" ;;
    *.webp) content_type="image/webp" ;;
    *) content_type="application/octet-stream" ;;
  esac

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer $HOSTR_TOKEN" \
    -H "Content-Type: $content_type" \
    --data-binary "@$file" \
    "https://hostr.flingit.run/s/$path/$relative"
done

echo "Published: https://hostr.flingit.run/s/$path/"
