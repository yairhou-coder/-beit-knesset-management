#!/bin/bash
# מפעיל את מערכת הניהול של בית המדרש אנשי מעשה (Linux)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js אינו מותקן. התקינו Node.js 20 ומעלה מ-https://nodejs.org"
  exit 1
fi

node scripts/launch.mjs
