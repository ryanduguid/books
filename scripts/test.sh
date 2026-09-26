#!/usr/bin/env zsh

set -o pipefail

if [ $# -eq 0 ]
  then
    set -- './**/tests/**/*.spec.ts'
fi

export IS_TEST=true
./scripts/runner.sh ./node_modules/.bin/tape "$@" | ./node_modules/.bin/tap-spec
