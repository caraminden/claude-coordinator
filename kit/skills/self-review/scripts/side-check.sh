#!/bin/sh
# Runs one self-review check so it can sit in the background beside the reviewer Grunt.
# usage: side-check.sh <name> <command> [args...]   (stdin passes through to the command)
# Writes $TMPDIR/side-checks/<name>.{out,err,exit,start,end} (epoch seconds), then prints
# nothing itself: the minion reads those files after the reviewer returns (self-review 2).
name=$1; shift
dir=${TMPDIR:-/tmp}/side-checks
mkdir -p "$dir"
rm -f "$dir/$name".*
date +%s > "$dir/$name.start"
"$@" > "$dir/$name.out" 2> "$dir/$name.err"
echo $? > "$dir/$name.exit"
date +%s > "$dir/$name.end"
