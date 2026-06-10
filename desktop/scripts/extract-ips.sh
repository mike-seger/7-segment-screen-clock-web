#!/usr/bin/env bash

grep "192" | grep -v mbp | cut -b 19- |sed -e 's/,.*//;' | tr -d "(" | tr " " "\t"
