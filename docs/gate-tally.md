# Gate tally

This file records, per rule, every time a gate rejected a deliverable and
what it caught. It is a measurement log, not a design document. Later
tooling in this project builds on top of the entries here.

| # | Date | Rule | What it caught |
|---|------|------|----------------|
| 1 | 2026-09-07 | Fail loud when a named specification file is missing | A build step was requested that named a specification file, but that file was not present in the repo. A file with a very similar name was present instead. The gate stopped the build instead of quietly substituting the similar file for the missing one, so nothing got built on a source that was never verified. |
