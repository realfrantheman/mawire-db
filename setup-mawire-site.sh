#!/bin/bash
# Run this from your Desktop/M&A folder to push it to mawire-site on GitHub
# Usage: bash setup-mawire-site.sh YOUR_GITHUB_TOKEN

TOKEN=$1
if [ -z "$TOKEN" ]; then
  echo "Usage: bash setup-mawire-site.sh YOUR_GITHUB_TOKEN"
  exit 1
fi

git remote add origin "https://${TOKEN}@github.com/realfrantheman/mawire-site.git" 2>/dev/null || \
git remote set-url origin "https://${TOKEN}@github.com/realfrantheman/mawire-site.git"

git add .
git commit -m "Initial commit — full frontend" 2>/dev/null || echo "Nothing new to commit"
git push -u origin main

echo "Done! mawire-site is now on GitHub."
