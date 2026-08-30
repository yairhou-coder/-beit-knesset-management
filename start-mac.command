#!/bin/bash
# מפעיל את מערכת הניהול של בית המדרש אנשי מעשה (macOS)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js אינו מותקן. נפתח את דף ההורדה..."
  echo "  התקינו את גרסת ה-LTS, ואז הריצו את הקובץ הזה שוב."
  echo ""
  open "https://nodejs.org"
  read -r -p "הקישו Enter לסגירה..."
  exit 1
fi

node scripts/launch.mjs
